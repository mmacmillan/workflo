/**
 * workflo.js
 * ----------
 *
 * @description provides a workflow centric approach to managing and running your aws SWF workflows.  offers a simple workflow schema to centralize workflow definitions and handling.
 * @author Mike MacMillan (mikejmacmillan@gmail.com)
 */

var Q = require('q'),
    _ = require('lodash'),
    aws = require('aws-sdk'),
    events = require('events'),
    util = require('util'),
    _workflows = {};

var workflow = {
    /**
     * @class workflow
     */

    define: function(name, opts) {
        if(!opts) return;

        var lib = this;
        var workflowObj = _.assign({
            name: name,
            domain: this.swfDomain,
            config: [],

            verify: function() {
                var def = Q.defer();

                //** asynchronously verify each of the activityTypes that are included in this workflow
                function verifyTasks() {
                    var actions = _.map(workflowObj.activities, function(obj) { return obj.verify() });
                    Q.all(actions).then(def.resolve, def.reject);
                }

                //** see if the workflow exists already, with this name/version
                lib.workflow.exists(workflowObj.name, workflowObj.config.version)
                    .then(verifyTasks)
                    .catch(function() {
                        var obj = _.extend({
                            name: workflowObj.name,
                            domain: workflowObj.domain,
                            defaultTaskStartToCloseTimeout: '30', //** 30 second limit on tasks to finish, within this workflow
                            defaultExecutionStartToCloseTimeout: ''+ ((60*60*24)*30) //** 30 days default, task limits will eliminate bottlenecks, but some workflows can take weeks
                        }, workflowObj.config||{});

                        //** create it otherwise
                        console.log('creating workflow: ', workflowObj.name, workflowObj.config.version);
                        lib.workflow.create(workflowObj.name, workflowObj.config.version, obj)
                            .then(verifyTasks)
                            .catch(def.reject);

                    }.bind(this));

                return def.promise;
            },

            evaluate: function(p, context, decision) {
                var history = context.history;

                //** 1) schedule the first activity if none have yet been completed.  if the first task was scheduled, timed out or
                //** failed, but not completed, then it will be re-run here
                if(!history.hasCompletedActivity()) {
                    var activity = this.activities[0];
                    decision.scheduleActivity(activity);
                    return p.resolve();
                }

                var data = {};

                //** 2) get the last completed activity, extract the result data.  by getting the last completed task, this will automatically
                //** retry activityTasks that were scheduled but not completed, when they are rescheduled.
                var lastCompleted = history.lastCompletedActivity();
                if(lastCompleted) {

                    var args = lastCompleted.activityTaskCompletedEventAttributes;

                    //** if the last completed activity had a result, it could be the next step's name
                    try {
                        data = JSON.parse(args && args.result);
                    } catch (e) {}
                }

                //** 3) see if the last step's data indicates the next step
                if(data.nextStep) {
                    var nextStep = _.find(this.activities, function(act) {
                        return act.name == data.nextStep;
                    });

                    //** if we found the step by name, schedule it to be run
                    nextStep && decision.scheduleActivity(nextStep);
                }

                //** 4) if we haven't decided yet, see if the last step's data indicates the workflow is complete
                if(!decision.decided() && data.complete)
                    decision.completeWorkflow(data);

                //** 5) let the workflow itself evaluate these decisions and provide any modifications
                this.onEvaluate && this.onEvaluate(context, decision);

                //** 6) finally, let any consumers evaluate the context and decisions
                lib.emit('workflow:evaluate', context, decision);

                p.resolve();
            },

            runActivity: function(name, context, response) {
                var def = Q.defer(),
                    prm = def.promise;

                util.log('runActivity: '+ name);

                //** get a reference to the workflows handler for this task
                var activityHandler = this.handlers[name];

                //** ensure there's a handler for this workflow activity
                if(!activityHandler)
                    def.reject('There is no handler available for the activity: '+ this.name +'/'+ name);

                //** trigger the handler; if it returns a promise, this is an async operation...handle it accordingly.  otherwise,
                //** it is synchronous, and we resolve() it immediately; any errors will bubble up to the parent catch()
                var promise = activityHandler(context, response);
                !!promise
                    ? promise.then(def.resolve, def.reject)
                    : def.resolve();

                return prm;
            }


        }, opts||{});

        //** parse the activities defined as activityType objects
        workflowObj.activities = _.map(workflowObj.activities||[], function(obj) {
            //** override the default task list, if the workflow has it specified
            if(!obj.defaultTaskList)
                obj.defaultTaskList = workflowObj.config.defaultTaskList;

            return this.activity.define(obj.name, obj);
        }.bind(this));

        _workflows[name] = workflowObj;
        return workflowObj;
    },

    verifyAll: function() {
        var def = Q.defer();

        //** call the verify() method of each workflow, waiting for them all to finish verifying before continuing
        var actions = _.map(_workflows, function(obj) { return obj.verify(); });
        Q.all(actions).then(def.resolve, def.reject);

        return def.promise;
    },

    exists: function(name, version) {
        return this.svc.describeWorkflowType({
            domain: this.swfDomain,
            workflowType: {
                name: name,
                version: version||'1.0'
            }
        });
    },

    create: function(name, version, opts) {
        opts = opts||{};
        opts.name = name;
        !!version && (opts.version = version);

        return this.svc.registerWorkflowType(opts);
    }

};


var activity = {
    /** 
     * @class activity
     */

    defaults: function(opts) {
        return (opts = _.defaults({}, opts||{}, {
            domain: this.swfDomain,
            version: '1.0',
            defaultTaskList: { name: 'main' },
            defaultTaskStartToCloseTimeout: '30',
            defaultTaskHeartbeatTimeout: '30',
            defaultTaskScheduleToStartTimeout: 'NONE', //** this indicates how long tasks can wait to be scheduled; defaulting to unlimited
            defaultTaskScheduleToCloseTimeout: 'NONE' //** this indicates how long tasks can exist period; defaulting to unlimited
        }));
    },

    /**
     * http://docs.aws.amazon.com/amazonswf/latest/apireference/API_RegisterActivityType.html
     * http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/SWF.html#registerActivityType-property
     */
    define: function(name, opts) {
        var obj = _.extend(this.activity.defaults(opts), { 
            name: name,

            verify: function() {
                var def = Q.defer();

                //** see if the activity type exists already, with this name/version
                this.activity.exists(obj.name, obj.version)
                    .then(def.resolve)
                    .catch(function() {

                        //** create it otherwise
                        console.log('creating activity: ', obj.name, obj.version);
                        this.activity.create(opts).then(def.resolve, def.reject);

                    }.bind(this));

                return def.promise;
            }.bind(this)
        });

        return obj;
    },

    exists: function(name, version) {
        return this.svc.describeActivityType({
            domain: this.swfDomain,
            activityType: {
                name: name,
                version: version||'1.0'
            }
        });
    },

    create: function(opts) {
        opt = this.activity.defaults(opts);
        return this.svc.registerActivityType(opt);
    },

    complete: function(taskToken, result) {
        return this.svc.respondActivityTaskCompleted({ taskToken: taskToken, result: result });
    },

    cancel: function(taskToken, details) {
        return this.svc.respondActivityTaskCancelled({ taskToken: taskToken, details: details });
    },

    fail: function(taskToken, details, reason) {
        return this.svc.respondActivityTaskFailed({ taskToken: taskToken, details: details, reason: reason });
    }
};


var poll = {

    /**
     * @class poll
     */

    decision: function(opts) {
        typeof(opts) == 'string' && (opts = { taskList: { name: opts }});
        _.defaults(opts||{}, { domain: this.swfDomain });

        function handleTask(data) {
            if(!!data.taskToken) {
                //** get a execution context, grabbing the ref to the workflow object we're executing
                var ctx = new workflowContext(data, this),
                    decision = new decisionResponse(ctx),
                    flow = ctx && ctx.workflow,
                    def = Q.defer(),
                    prm = def.promise;

                //** let the workflow definition evaluate the context and decide on the next action
                flow.evaluate(def, ctx, decision);

                prm
                    .then(function() {
                        //** if a decision has been made, send it
                        if(decision.decided()) {
                            console.log('sending decision: ', decision.decisions[0]);
                            this.svc.respondDecisionTaskCompleted({
                                taskToken: decision.taskToken,
                                decisions: decision.decisions
                            });
                        }

                        this.emit('decision', decision);
                    }.bind(this))
                    .catch(this.emit.bind(this, 'error', decision))
                    .finally(function() {
                        //** continue polling...always polling
                        setTimeout(this.poll.decision.bind(this, opts), 0);
                    }.bind(this));
            } else
                setTimeout(this.poll.decision.bind(this, opts), 0);
        }

        this.emit('polling', opts);
        this.svc.pollForDecisionTask(opts).done(handleTask.bind(this));
        return this;
    },

    activity: function(opts) {
        typeof(opts) == 'string' && (opts = { taskList: { name: opts }});
        _.defaults(opts||{}, { domain: this.swfDomain });

        function handleTask(data) {
            if(!!data.taskToken) {
                //** get a execution context, grabbing the ref to the workflow object we're executing
                var ctx = new workflowContext(data, this),
                    response = new activityResponse(ctx),
                    flow = ctx && ctx.workflow;

                //** run the activity via its parent workflow
                flow && flow.runActivity(ctx.activityType.name, ctx, response)
                    .then(done.bind(this, true))
                    .catch(done.bind(this, false));

                function done(success) {
                    this.emit('activity:'+ (!!success?'success':'fail'), ctx);
                    setTimeout(this.poll.activity.bind(this, opts), 0);
                }
            } else
                setTimeout(this.poll.activity.bind(this, opts), 0);
        }

        this.emit('polling', opts);
        this.svc.pollForActivityTask(opts).done(handleTask.bind(this));
        return this;
    }
};



var decisions = {
    /**
     * provides methods to generate the args for each of the decisions a decider can respond with, in their most minimal form; see
     * the docs for more info:
     * http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/SWF.html#respondDecisionTaskCompleted-property
     * and
     * http://docs.aws.amazon.com/amazonswf/latest/apireference/API_RespondDecisionTaskCompleted.html
     * and (best)
     * http://docs.aws.amazon.com/amazonswf/latest/apireference/API_Decision.html
     *
     * @class decisions
     */

    scheduleActivityTask: function(name, version, id, opt) {
        return {
            decisionType: 'ScheduleActivityTask',
            scheduleActivityTaskDecisionAttributes: _.defaults(opt||{}, {
                activityId: id || name + '-' + Date.now(),
                activityType: {
                    name: name,
                    version: version || '1.0'
                }
            })
        };
    },

    completeWorkflow: function(result) {
        result = result||{};
        typeof(result) == 'object' && (result = JSON.stringify(result));

        return {
            decisionType: 'CompleteWorkflowExecution',
            completeWorkflowExecutionDecisionAttributes: { result: result }
        }
    }
};



/**
 * provides a context that can be used while a workflow is being executed.  this context can be used by the deciders to help
 * evaluate the event history and make the correct decision.  the executionContext provides helpers for evaluating the history
 * and making decisions.
 */
function workflowContext(data, lib) {
    data = data||{};

    _.extend(this, data, {
        //** provide a reference to the workflow being executed, along with an eventHistory collection for access events
        lib: lib,
        workflow: data.workflowType && _workflows[data.workflowType.name],
        history: new eventHistory(data.events)
    });

    var y = 1;
};




function decisionResponse(context) {
    this.context = context;
    this.taskToken = context.taskToken;
    this.decisions = [];
    this.data = {};

    //** any time a decision is made, it may or may not send data back with the task.  typically it *should* serialize
    //** the this.data object and send it, so that whatever data has been accrued for that decision is sent.  *at least*
    //** send the workflow name so that it can be retrieved
    !context.input && (this.data = {
        workflow: this.context.workflow.name
    });

    //** try to deserialize the input as a json message
    try {
        context.input && (this.data = JSON.parse(context.input));
    } catch(e) {}
};

_.extend(decisionResponse.prototype, {
    decided: function() { return this.decisions.length > 0; },

    //** shorthand to schedule an activity task as part of the response.  accepts an activityTask object as well as
    //** being invoked with each individual field
    scheduleActivity: function(name, version, opts) {
        //** accept an activityType object (or any object...)
        if(typeof(name) === 'object') {
            var obj = name;
            opts = version;

            name = obj.name;
            version = obj.version;
        }

        this.decisions.push(decisions.scheduleActivityTask(name, version, null, _.extend(opts||{}, {
            input: JSON.stringify(this.data)
        })));
    },

    //** queue a complete workflow decision, with the given result; if an object, it will be serialized to json
    completeWorkflow: function(result) {
        this.decisions.push(decisions.completeWorkflow(result));
    }
});




function activityResponse(context) {
    this._defer = Q.defer();
    this.context = context;
    this.taskToken = context.taskToken;
    this.data = {};

    //** try to deserialize the input as a json message
    try {
        context.input && (this.data = JSON.parse(context.input));
    } catch(e) {}

    //** if this activities data carries the name of the workflow, try and get the actual workflow reference for the context
    if(!!this.data.workflow)
        context.workflow = _workflows[this.data.workflow];
};

_.extend(activityResponse.prototype, {
    //** return .async() from handler methods if you want them to be run asynchronously using a promise...this just returns the promise for this response
    async: function() { return this._defer.promise; },

    //** accepts a result as a string or an object.  if the result is a string, it is assumed to be the next steps name.  this allows
    //** an easy way to indicate to the decider what the next step should be
    complete: function(result) {
        //** if the result is a string, assume it to be the name of the next step
        if(typeof(result) == 'string')
            result = { nextStep: result };

        //** we resolve/reject this responses promise for any consumers of the handler task that was run for this execution
        var prm = this.context.lib.activity.complete(this.taskToken, JSON.stringify(result));
        prm.then(this._defer.resolve, this._defer.reject);
        return prm;
    },

    fail: function(details, reason) {
        var prm = this.context.lib.activity.fail(this.taskToken, details, reason);
        prm.then(this._defer.resolve, this._defer.reject);
        return prm;
    },

    cancel: function(details) {
        var prm = this.context.lib.activity.cancel(this.taskToken, details);
        prm.then(this._defer.resolve, this._defer.reject);
        return prm;
    },

    completeWorkflow: function(result) {
        //** if the result is a string, do not assume it is serialized, pass it as the result
        if(typeof(result) == 'string')
            result = { result: result };

        //** indicate the workflow is complete
        result.complete = true;
        var prm = this.context.lib.activity.complete(this.taskToken, JSON.stringify(result));
        prm.then(this._defer.resolve, this._defer.reject);
        return prm;
    }
});






/**
 * an event history collection object; wraps the events for an execution context, providing some helpers
 */
function eventHistory(events, opts) {
    this.events = events||[];
    this.options = opts||{};
    this.sorted = this.sortBy(function(evt) { return evt.eventTimestamp });
}

//** add some helpers to the eventHistory courtesy of lodash
['contains', 'each', 'find', 'filter', 'map', 'reduce', 'sortBy', 'where'].forEach(function(key) {
    eventHistory.prototype[key] = function() {
        var args = [this.events].concat(_.toArray(arguments));
        return _[key].apply(_, args);
    }
});

//** add some additional helpers to the eventHistory
_.assign(eventHistory.prototype, {
    current: function() { return this.sorted[this.sorted.length > 0 && this.sorted.length - 1 || 0]; },
    previous: function() { return this.sorted[this.sorted.length - (this.sorted.length >= 2 ? 2 : 1)]; },

    lastActivity: function() {
        return this.eventsByType('ActivityTaskStarted').pop();
    },

    lastScheduledActivity: function() {
        return this.eventsByType('ActivityTaskScheduled').pop();
    },

    lastCompletedActivity: function() {
        return this.eventsByType('ActivityTaskCompleted').pop();
    },

    //** returns a filtered listed of the event history based on event type
    eventsByType: function(type) {
        return this.filter(function(evt) {
            return evt.eventType.toLowerCase() == (type||'').toLowerCase();
        });
    },

    //** is this the first decision we're making for this particular execution of this workflow
    isFirstDecision: function() {
        var evt = this.eventsByType('DecisionTaskStarted');
        return !!evt.length && this.events.length <= 3;
    },

    hasRunActivity: function() {
        return !!this.lastScheduledActivity();
    },

    hasCompletedActivity: function() {
        return !!this.lastCompletedActivity();
    }
});



var workflo = module.exports = function(opt) {
    events.EventEmitter.call(this);

    //** simple wrapper function for introducing a promise interface
    function wrap(ctx, fn, key) {
        return function() {
            var def = Q.defer(),
                args = _.toArray(arguments);

            args.push(def.makeNodeResolver());
            fn.apply(ctx, args);

            return def.promise;
        }
    }

    //** proxy the options unchanged to the aws-sns sdk for creation
    this.swf = new aws.SWF((opt=opt||{}));
    this.swfDomain = opt.domain;
    this.svc = {};

    //** create a curried version of each swf sdk api function, introducing a promise interface, hoisting it to a service object
    _.each(this.swf.constructor.prototype, function(obj, key) {
        if(typeof(obj) !== 'function' || key == 'constructor') return;
        this.svc[key] = wrap(this.swf, obj, key);
    }.bind(this));

    var scope = function(ctx, fn, key) { 
        ctx[key] = fn.bind(this);
        return ctx;
    }.bind(this);

    //** scope each of the individual service libs
    this.workflow = _.reduce(workflow, scope, {}); 
    this.activity = _.reduce(activity, scope, {});
    this.poll = _.reduce(poll, scope, {});
    this.decisions = _.reduce(decisions, scope, {});
};
util.inherits(workflo, events.EventEmitter);

