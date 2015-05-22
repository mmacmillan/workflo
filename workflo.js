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
            config: {},
            swfConfig: {},

            verify: function() {
                var def = Q.defer();

                //** asynchronously verify each of the activityTypes that are included in this workflow
                function verifyTasks() {
                    var actions = _.map(workflowObj.activities, function(obj) { return obj.verify() });
                    Q.all(actions).then(def.resolve, def.reject);
                }

                //** see if the workflow exists already, with this name/version
                lib.workflow.exists(workflowObj.name, workflowObj.swfConfig.version)
                    .then(verifyTasks)
                    .catch(function() {
                        var obj = _.extend({
                            name: workflowObj.name,
                            domain: workflowObj.domain,
                            defaultTaskStartToCloseTimeout: '5', //** 5 second limit on tasks to finish, within this workflow, if none specified @ the task level
                            defaultExecutionStartToCloseTimeout: ''+ ((60*60*24)*180), //** 180 days default, task limits will eliminate bottlenecks, but some workflows can take weeks
                            defaultChildPolicy: 'TERMINATE', //** by default, when terminated, child processes will also be terminated
                            defaultTaskList: lib.defaultTaskList
                        }, workflowObj.swfConfig||{});

                        //** create it otherwise
                        lib.emit('workflow:create', workflowObj);
                        lib.workflow.create(workflowObj.name, workflowObj.swfConfig.version, obj)
                            .then(verifyTasks)
                            .catch(def.reject);

                    }.bind(this))
                    .catch(def.reject);

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

                var data = {},
                    lastFailed = history.lastFailedActivity(),
                    lastCompleted = history.lastCompletedActivity(),
                    lastScheduled = history.lastScheduledActivity(),
                    previousFail = false;

                //** 2) we need to see if there was an error with one of the previous activities that needs to be handled

                //** if we have a failed task, but no completed tasks, we're need to retrying the same task again
                if(lastFailed && !lastCompleted)
                    previousFail = true;

                //** since our last event could be many things other than a fail or complete event for an activity, compare the
                //** last failed activity with the last completed activity; if the last completed activity comes after the failure
                //** we can safely assume the failure was recovered; if the failure came after, we need to recover from that failure
                if(lastFailed && lastCompleted) {
                    var lastFailId = lastFailed.args().scheduledEventId,
                        lastCompletedId = lastCompleted.args().scheduledEventId;

                    if(parseInt(lastFailId) >= parseInt(lastCompletedId))
                        previousFail = true;
                }

                if(previousFail) {
                    var details = lastFailed.args().details,
                        activity = null;

                    //** see if the task that failed specified what its next step should be
                    if (!!details.next)
                        activity = this.getActivity(details.next);
                    else {
                        //** otherwise, attempt to retrieve the last task scheduled to be run
                        if (lastScheduled) {
                            var args = lastScheduled.args(),
                                name = args && args.activityType && args.activityType.name;

                            //** if found, assign the activity so its scheduled to be run
                            name && (activity = this.getActivity(name));
                        }
                    }

                    //** before scheduling a new activity, see if we've hit our maximum failures allows for this workflow
                    if (this.config && this.config.maxFailures) {
                        var failed = history.eventsByType('ActivityTaskFailed').length;
                        if (failed >= parseInt(this.config.maxFailures)) {
                            decision.failWorkflow(details, 'maximum failures reached');
                            return p.resolve();
                        }
                    }


                    //** if a fail activity was found, run it
                    if(activity) {
                        decision.scheduleActivity(activity);
                        return p.resolve();
                    }
                }

                //** 3) get the last completed activity, extract the result data.  by deciding what task to run based on the last *completed* task,
                //** that means we will always be running the correct next task, regardless if a thousand failed iterations of the next task ran before this decision
                if(lastCompleted)
                    data = lastCompleted.args().result;

                //** 3) see if the last step's data indicates the next step
                if(data.next) {
                    var nextStep = _.find(this.activities, function(act) {
                        return act.name == data.next;
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
                lib.emit('workflow:evaluate', this, context, decision);

                p.resolve();
            },

            getActivity: function(name) {
                return _.find(this.activities, function(act) { return act.name == name; });
            },

            runActivity: function(name, context, response) {
                var def = Q.defer(),
                    prm = def.promise;

                //** get a reference to the workflows handler for this task
                var activityHandler = this.handlers[name];

                //** ensure there's a handler for this workflow activity
                if(!activityHandler)
                    def.reject('There is no handler available for the activity: '+ this.name +'/'+ name);

                //** trigger the handler; if it returns a promise, this is an async operation...handle it accordingly.  otherwise,
                //** it is synchronous, and we resolve() it immediately; any errors will bubble up to the parent catch()
                lib.emit('workflow:runActivity', this, name);
                var promise = activityHandler(context, response);
                !!promise
                    ? promise.then(def.resolve, def.reject)
                    : def.resolve();

                return prm;
            }
        }, opts||{});


        //** define some workflo specific config settings
        _.defaults(workflowObj.config, {
            maxFailures: 10
        });

        //** parse the activities defined as activityType objects
        workflowObj.activities = _.map(workflowObj.activities||[], function(obj) {
            //** override the default task list, if the workflow has it specified
            if(!obj.defaultTaskList)
                obj.defaultTaskList = workflowObj.swfConfig.defaultTaskList;

            return this.activity.define(obj.name, obj);
        }.bind(this));

        _workflows[name] = workflowObj;
        return workflowObj;
    },

    verifyAll: function() {
        var def = Q.defer();

        //** call the verify() method of each workflow, waiting for them all to finish verifying before continuing
        var actions = _.map(_workflows, function(obj) { return obj.verify(); });
        Q.all(actions)
            .then(def.resolve)
            .catch(def.reject);

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
    },

    execute: function(id, name, version, opts) {
        opts = _.defaults(opts||{}, {
            domain: this.swfDomain,
            taskList: this.defaultTaskList,
            workflowId: id || (name + Date.now()),
            workflowType: {
                name: name,
                version: version || '1.0'
            }
        });

        return this.svc.startWorkflowExecution(opts);
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
                        this.emit('activity:create', obj);
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

    //** opts: maximumPageSize, <add more>
    decision: function(opts) {
        typeof(opts) == 'string' && (opts = { taskList: { name: opts }});
        opts = _.defaults(opts||{}, {
            domain: this.swfDomain,
            taskList: this.defaultTaskList
        });

        function handleTask(data) {
            if(!!data.taskToken) {
                //** get a execution context, grabbing the ref to the workflow object we're executing
                var ctx = new workflowContext(data, this),
                    lib = this;

                //** make sure we've loaded the full event history for this workflow...in the future this could be optional
                ctx.loadFullHistory().then(function() {

                    var decision = new decisionResponse(ctx),
                        flow = ctx && ctx.workflow,
                        def = Q.defer(),
                        prm = def.promise;

                    //** let the workflow definition evaluate the context and decide on the next action
                    flow.evaluate(def, ctx, decision);

                    //** if a decision has been made, send it
                    prm.then(function () {
                        if (decision.decided()) {
                            console.log('sending decision: ', decision.decisions[0]);
                            lib.svc.respondDecisionTaskCompleted({
                                taskToken: decision.taskToken,
                                decisions: decision.decisions
                            });
                        }

                        lib.emit('decision', decision);
                    })

                    //** report any errors
                    .catch(lib.emit.bind(lib, 'error', decision));
                });
            }

            //** continue polling...always polling
            setTimeout(this.poll.decision.bind(this, opts), 0);
        }

        this.emit('polling', opts);
        this.svc.pollForDecisionTask(opts).done(handleTask.bind(this));
        return this;
    },

    activity: function(opts) {
        typeof(opts) == 'string' && (opts = { taskList: { name: opts }});
        opts = _.defaults(opts||{}, {
            domain: this.swfDomain,
            taskList: this.defaultTaskList
        });

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
                }

                //** if we do nothing, it will time out and run the task again after it times out...
            }

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
    },

    failWorkflow: function(details, reason) {
        details = details||{};
        typeof(details) == 'object' && (details = JSON.stringify(details));

        return {
            decisionType: 'FailWorkflowExecution',
            failWorkflowExecutionDecisionAttributes: { details: details, reason: reason }
        }
    },

    cancelWorkflow: function(details) {
        details = details||{};
        typeof(details) == 'object' && (details = JSON.stringify(details));

        return {
            decisionType: 'CancelWorkflowExecution',
            cancelWorkflowExecutionDecisionAttributes: { details: details }
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

    function loadHistory(nextPageToken) {
        var started = this.history.eventsByType('WorkflowExecutionStarted').pop(),
            taskList = {},
            def = Q.defer();

        //** find the tasklist from the workflow execution started event
        if(!!started)
            taskList = started.args().taskList;

        lib.svc.pollForDecisionTask({
            domain: lib.swfDomain,
            taskList: taskList,
            nextPageToken: nextPageToken
        })
            .then(function(data) {
                //** add the history events
                data = data||{};
                this.history.addEvents(data.events||[]);

                //** if there is a next page token, keep following the token...otherwise, resolve the promise, indicating history is "good"
                !!data.nextPageToken
                    ? loadHistory.call(this, data.nextPageToken).then(def.resolve)
                    :  def.resolve();
            }.bind(this))
            .catch(def.reject);

        return def.promise;
    }

    _.extend(this, data, {
        //** provide a reference to the workflow being executed, along with an eventHistory collection for access events
        lib: lib,
        workflow: data.workflowType && _workflows[data.workflowType.name],
        history: new eventHistory(data.events),

        loadFullHistory: function() {
            var def = Q.defer();

            !!data.nextPageToken
                ? loadHistory.call(this, data.nextPageToken).then(def.resolve)
                : def.resolve();

            return def.promise;
        }
    });
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
    },

    failWorkflow: function(details, reason) {
        this.decisions.push(decisions.failWorkflow(details, reason));
    },

    cancelWorkflow: function(details) {
        this.decisions.push(decisions.cancelWorkflow(details));
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
        typeof(result) == 'string' && (result = { next: result });

        //** we resolve/reject this responses promise for any consumers of the handler task that was run for this execution
        var prm = this.context.lib.activity.complete(this.taskToken, JSON.stringify(result));
        prm.then(this._defer.resolve, this._defer.reject);
        return prm;
    },

    fail: function(details, reason) {
        //** allow details to be an object, but pass a string to the api.  if no reason is provided, assume details are the "reason"
        details = details||{};
        if(typeof(details) == 'string') {
            if(!reason) {
                reason = details;
                details = {};
            } else
                details = { next: details };
        }

        var prm = this.context.lib.activity.fail(this.taskToken, JSON.stringify(details), reason);
        prm.then(this._defer.resolve, this._defer.reject);
        return prm;
    },

    cancel: function(details) {
        //** allow details to be an object, but pass a string to the api
        typeof(details) == 'object' && (details = JSON.stringify(details));

        var prm = this.context.lib.activity.cancel(this.taskToken, details);
        prm.then(this._defer.resolve, this._defer.reject);
        return prm;
    },

    completeWorkflow: function(result) {
        result = result||{};

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

    addEvents: function(events) {
        !Array.isArray(events) && (events = [events]);
        this.events = this.events.concat(events);
        this.sorted = this.sortBy(function(evt) { return evt.eventTimestamp });
    },

    lastActivity: function() {
        return this.eventsByType('ActivityTaskStarted').pop();
    },

    lastScheduledActivity: function() {
        return this.eventsByType('ActivityTaskScheduled').pop();
    },

    lastCompletedActivity: function() {
        return this.eventsByType('ActivityTaskCompleted').pop();
    },

    lastFailedActivity: function() {
        return this.eventsByType('ActivityTaskFailed').pop();
    },

    //** returns a filtered listed of the event history based on event type
    eventsByType: function(type) {
        return this.filter(function(evt) {
            if(evt.eventType.toLowerCase() == (type||'').toLowerCase()) {
                this.wrapEvent(evt);
                return true;
            }
        }.bind(this));
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
    },

    wrapEvent: function(evt) {
        if(!!evt.args) return evt;

        //** wraps and extends the event object with helpers
        _.assign(evt, {
            //** provides easy access to the event args.  they are commonly stored as <EventTypeName>EventAttributes
            args: function() {
                var name = evt.eventType[0].toLowerCase() + evt.eventType.slice(1);
                return this[name +'EventAttributes'] || {};
            }
        });

        //** try to parse the fields that may hold json data
        var args = evt.args();
        try {
            if(args.details && typeof(args.details) == 'string')
                args.details = JSON.parse(args.details);

            if(args.result && typeof(args.result) == 'string')
                args.result = JSON.parse(args.result);
        } catch(e) {}
    }
});



var workflo = module.exports = function(opt) {
    events.EventEmitter.call(this);

    //** proxy the options unchanged to the aws-sns sdk for creation
    this.swf = new aws.SWF((opt = opt || {}));
    this.swfDomain = opt.domain;
    this.defaultTaskList = opt.defaultTaskList;
    this.svc = {};

    //** create a curried version of each swf sdk api function, introducing a promise interface, hoisting it to a service object
    _.each(this.swf.constructor.prototype, function (fn, key) {
        if (typeof(fn) !== 'function' || key == 'constructor') return;
        this.svc[key] = Q.nbind(fn, this.swf);
    }.bind(this));

    var scope = function (ctx, fn, key) {
        ctx[key] = fn.bind(this);
        return ctx;
    }.bind(this);

    //** scope each of the individual service libs
    this.workflow = _.reduce(workflow, scope, {});
    this.activity = _.reduce(activity, scope, {});
    this.poll = _.reduce(poll, scope, {});
    this.decisions = _.reduce(decisions, scope, {});

    //** simple helper function to execute a workflow, using the syntax: workflo.run('some-test-workflow')
    this.run = function (name, id, taskList, opts) {
        opts = opts || {};
        var def = Q.defer();

        //** get the workflow we're trying to run
        var wkflow = _workflows[name];

        if(!wkflow) {
            def.reject('Could not find the target workflow');
        } else {
            //** use the version of the workflow we're running (in case multiple versions exist in swf)
            var version = opts.version || wkflow.swfConfig.version;
            !!taskList && (opts.taskList = { name: taskList });

            //** execute the tasklist
            this.workflow.execute(id, name, version, opts).done();
        }

        return def.promise;
    }.bind(this);
};
util.inherits(workflo, events.EventEmitter);
