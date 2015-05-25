/**
 * workflo.js
 * ----------
 *
 * @description provides a schema centric framework for managing and running your aws SWF workflows
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

            //** defines the aws swf specific config/defaults
            swfConfig: {},

            //** defines some workflo specific config/defaults
            config: {
                maxFailures: 10
            },

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

            evaluate: function(p, context) {
                var data = {},
                    history = context.history,
                    lastFailed = history.lastFailedActivity(),
                    lastCompleted = history.lastCompletedActivity(),
                    lastScheduled = history.lastScheduledActivity(),
                    previousFail = false;

                //** see if the workflow was cancelled
                //**** add here

                //** if we have a failed task, but no completed tasks, we need to retry the same task again
                if(lastFailed && !lastCompleted)
                    previousFail = true;

                //** since our last event could be many things other than a fail or complete event for an activity, compare the
                //** last failed activity with the last completed activity; if the last completed activity comes after the failure
                //** we can safely assume the failure was recovered; if the failure came after, we need to recover from that failure
                if(!previousFail && (lastFailed && lastCompleted)) {
                    var lastFailId = lastFailed.args().scheduledEventId,
                        lastCompletedId = lastCompleted.args().scheduledEventId;

                    if(parseInt(lastFailId) >= parseInt(lastCompletedId))
                        previousFail = true;
                }

                if(previousFail) {
                    var details = lastFailed.args().details,
                        activity = null;

                    //** see if the last failed task specified that the workflow should be marked as failed
                    if(!!details.workflowFailed) {
                        context.failWorkflow(details, lastFailed.args().reason);
                        return p.resolve();
                    }

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
                            context.failWorkflow(details, 'maximum failures reached');
                            return p.resolve();
                        }
                    }


                    //** if a fail activity was found, run it
                    if(activity) {
                        context.schedule(activity);
                        return p.resolve();
                    }
                }

                //** if no activities have been completed yet, schedule the first activity for execution
                if(!history.hasCompletedActivity()) {
                    var activity = this.activities[0];
                    context.schedule(activity);
                    return p.resolve();
                }

                //** get the last completed activity, extract the result data.  by deciding what task to run based on the last *completed* task,
                //** that means we will always be running the correct next task, regardless if a thousand failed iterations of the next task ran before this decision
                if(lastCompleted)
                    data = lastCompleted.args().result;

                //** 3) see if the last step's data indicates the next step
                if(data.next) {
                    var nextStep = _.find(this.activities, function(act) {
                        return act.name == data.next;
                    });

                    //** if we found the step by name, schedule it to be run
                    nextStep && context.schedule(nextStep);
                }

                //** 4) if we haven't decided yet, see if the last step's data indicates the workflow is complete
                if(!context.decided() && data.workflowComplete)
                    context.completeWorkflow(data);

                //** 5) let the workflow itself evaluate these decisions and provide any modifications
                this.onEvaluate && this.onEvaluate(context);

                //** 6) finally, let any consumers evaluate the context and decisions
                lib.emit('workflow:evaluate', this, context);

                p.resolve();
            },

            getActivity: function(name) {
                return _.find(this.activities, function(act) { return act.name == name; });
            },

            runActivity: function(name, context) {
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
                var promise = activityHandler(context);
                !!promise
                    ? promise.then(def.resolve, def.reject)
                    : def.resolve();

                return prm;
            }
        }, opts||{});


        //** parse the activities defined as activityType objects
        workflowObj.activities = _.map(workflowObj.activities||[], function(obj) {
            obj.workflow = workflowObj;

            //** if the task hasn't specified a default task list, use the taskList from the workflow, if defined, falling back on the configured default task list
            if(!obj.defaultTaskList)
                obj.defaultTaskList = workflowObj.swfConfig.defaultTaskList||this.defaultTaskList;

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

    execute: function(name, version, data, opts) {
        //** provide the default options for starting a workflow, if not specified
        opts = _.defaults(opts||{}, {
            domain: this.swfDomain,
            taskList: this.defaultTaskList,
            workflowId: name +'-'+ Date.now(),
            workflowType: {
                name: name,
                version: version||'1.0'
            }
        });

        //** serialize the data, send the request to execute the workflow
        !!data && typeof(data) === 'object' && (opts.input = JSON.stringify(data));
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
                        //** clone the options and remove the workflow field
                        var data = _.clone(opts);
                        delete data['workflow'];

                        //** create it otherwise
                        this.emit('activity:create', obj);
                        this.activity.create(data).then(def.resolve, def.reject);

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
    },

    startChildWorkflow: function(name, data, opts) {
        //** provide the default options for starting a workflow, if not specified
        opts = _.defaults(opts||{}, {
            workflowId: name +'-'+ Date.now(),
            workflowType: {
                name: name,
                version: '1.0'
            }
        });

        //** serialize the data, send the decision to start the child workflow
        !!data && typeof(data) === 'object' && (opts.input = JSON.stringify(data));
        return this.svc.respondActivity(opts);
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
                var decision = new decisionContext(data, this),
                    lib = this;

                //** make sure we've loaded the full event history for this workflow...in the future this could be optional
                decision.loadFullHistory().then(function() {

                    var flow = decision.workflow,
                        def = Q.defer(),
                        prm = def.promise;

                    //** let the workflow definition evaluate the context and decide on the next action
                    flow.evaluate(def, decision);

                    //** if a decision has been made, send it
                    prm.then(function () {
                        if (decision.decided()) {
                            console.log('sending decision: ', decision.decisions[0]);
                            lib.svc.respondDecisionTaskCompleted({
                                taskToken: decision.context.taskToken,
                                decisions: decision.decisions
                            });
                        }

                        lib.emit('decision', decision);
                    });
                })

                //** report any errors
                .catch(lib.emit.bind(lib, 'error', decision));
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
                var activity = new activityContext(data, this);

                //** run the activity via its parent workflow
                activity.workflow.runActivity(activity.context.activityType.name, activity)
                    .then(done.bind(this, true))
                    .catch(done.bind(this, false));

                function done(success) {
                    this.emit('activity:'+ (!!success?'success':'fail'), activity);
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
            scheduleActivityTaskDecisionAttributes: _.assign((opt=opt||{}), {
                activityId: opt.activityId || (id || name + '-' + Date.now()),
                activityType: opt.activityType || {
                    name: name,
                    version: version || '1.0'
                },
                input: typeof(opt.input) === 'string' && opt.input || JSON.stringify(opt.input||{})
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


function decisionContext(data, lib) {

    function loadHistory(nextPageToken) {
        var started = this.history.workflowStartedActivity(),
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
            .then(function(res) {
                //** add the history events
                res = res||{};
                this.history.addEvents(res.events||[]);

                //** if there is a next page token, keep following the token...otherwise, resolve the promise, indicating history is "good"
                !!res.nextPageToken
                    ? loadHistory.call(this, res.nextPageToken).then(def.resolve)
                    :  def.resolve();
            }.bind(this))
            .catch(def.reject);

        return def.promise;
    }

    _.extend(this, {
        //** provide a reference to the workflow being executed, along with an eventHistory collection for access events
        context: data,
        lib: lib,
        decisions: [],
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

    //** a decision is always based on a workflow, so make sure we've been able to dereference the workflow requested
    if(!this.workflow)
        throw new Error('The decision context doesnt have a valid workflow');

    //** get the last scheduled activity, last completed activity, and the activity for when the workflow started
    var current = this.history.lastScheduledActivity(),
        completed = this.history.lastCompletedActivity(),
        start = this.history.workflowStartedActivity();

    //** create an aggregate data object for this decision, based on the data passed to the tasks/workflow
    this.data = _.assign(
        { workflow: this.workflow.name },
        start && start.args().input||{},
        completed && completed.args().result||{},
        current && current.args().input||{}
    );
};

_.extend(decisionContext.prototype, {
    decided: function() { return this.decisions.length > 0; },

    //** for scheduling an activity task using the activity object from the workflow
    schedule: function(activity, opts) {
        opts = opts||{};
        var taskList = opts.taskList || activity.defaultTaskList;

        _.defaults(opts, {
            //** use the task list for the workflow, if none specified specifically at the task level
            taskList: taskList || this.workflow.swfConfig.defaultTaskList,

            //** if input was provided for the activity, combine it with the existing data context
            input: _.assign(this.data, opts.input||{})
        });

        this.decisions.push(decisions.scheduleActivityTask(activity.name, activity.version, null, opts));
    },

    //** for scheduling an activity task by name/version; this method enforces the version passed by setting it on the activity
    scheduleActivity: function(name, version, opts) {
        var activity = _.clone(this.workflow.getActivity('name'));

        activity.version = version||'1.0';
        this.schedule(activity, opts);
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




function activityContext(data, lib) {
    this._defer = Q.defer();
    this.lib = lib;
    this.context = data;
    this.data = {};

    //** try to deserialize the input as a json message
    try {
        data.input && (this.data = JSON.parse(data.input));
    } catch(e) {}

    //** if this activities data carries the name of the workflow, try and get the actual workflow reference for the context
    if(!!this.data.workflow)
        this.workflow = _workflows[this.data.workflow];

    //** an activity is always based on a workflow, so make sure we've been able to dereference the workflow requested
    if(!this.workflow)
        throw new Error('The activity context doesnt have a valid workflow');
};

_.extend(activityContext.prototype, {
    //** return .async() from handler methods if you want them to be run asynchronously using a promise...this just returns the promise for this response
    async: function() { return this._defer.promise; },

    //** accepts a result as a string or an object.  if the result is a string, it is assumed to be the next steps name.  this allows
    //** an easy way to indicate to the decider what the next step should be
    complete: function(result) {
        //** if the result is a string, assume it to be the name of the next step
        typeof(result) == 'string' && (result = { next: result });

        //** we resolve/reject this responses promise for any consumers of the handler task that was run for this execution
        var prm = this.lib.activity.complete(this.context.taskToken, JSON.stringify(result));
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

        var prm = this.lib.activity.fail(this.context.taskToken, JSON.stringify(details), reason);
        prm.then(this._defer.resolve, this._defer.reject);
        return prm;
    },

    cancel: function(details) {
        //** allow details to be an object, but pass a string to the api
        typeof(details) == 'object' && (details = JSON.stringify(details));

        var prm = this.lib.activity.cancel(this.context.taskToken, details);
        prm.then(this._defer.resolve, this._defer.reject);
        return prm;
    },

    startChildWorkflow: function(name, data, opts) {
        var prm = this.lib.activity.startChildWorkflow(name, data, opts);
        prm.then(this._defer.resolve, this._defer.reject);
        return prm;
    },

    completeWorkflow: function(result) {
        result = result||{};

        //** if the result is a string, do not assume it is serialized, pass it as the result
        if(typeof(result) == 'string')
            result = { result: result };

        //** indicate the workflow is complete
        result.workflowComplete = true;
        var prm = this.lib.activity.complete(this.context.taskToken, JSON.stringify(result));
        prm.then(this._defer.resolve, this._defer.reject);
        return prm;
    },

    failWorkflow: function(details, reason) {
        details = details||{};

        if(typeof(details) === 'string') {
            reason = details;
            details = {};
        }

        //** indicate the workflow has failed, before failing the task
        details.workflowFailed = true;
        return this.fail(details, reason);
    },

    cancelWorkflow: function(details) {
        //** indicate the workflow has been cancelled
        details = details||{};
        details.workflowCancelled = true;

        return this.cancel(details);
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
    current: function() { return this.wrapEvent(this.sorted[this.sorted.length > 0 && this.sorted.length - 1 || 0]); },
    previous: function() { return this.wrapEvent(this.sorted[this.sorted.length - (this.sorted.length >= 2 ? 2 : 1)]); },

    addEvents: function(events) {
        !Array.isArray(events) && (events = [events]);
        this.events = this.events.concat(events);
        this.sorted = this.sortBy(function(evt) { return evt.eventTimestamp });
    },

    workflowStartedActivity: function() {
        return this.eventsByType('WorkflowExecutionStarted').pop();
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
            if(evt.eventType.toLowerCase() == (type||'').toLowerCase())
                return !!this.wrapEvent(evt);
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
            if(args.input && typeof(args.input) == 'string')
                args.input = JSON.parse(args.input);

            if(args.details && typeof(args.details) == 'string')
                args.details = JSON.parse(args.details);

            if(args.result && typeof(args.result) == 'string')
                args.result = JSON.parse(args.result);
        } catch(e) {}

        return evt;
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
    this.run = function (name, data, taskList, opts) {
        opts = opts || {};
        var def = Q.defer();

        //** get the workflow we're trying to run
        var wkflow = _workflows[name];

        if(!wkflow) {
            def.reject('Could not find the target workflow');
        } else {
            //** use the version of the workflow we're running (in case multiple versions exist in swf)
            var version = opts.version || wkflow.swfConfig.version,
                taskList = (typeof(taskList) === 'string' ? { name: taskList } : taskList) || wkflow.swfConfig.defaultTaskList;

            //** use the default tasklist for workflo if none specified for the target workflow, or method invocation
            if(!taskList) taskList = this.defaultTaskList;
            !!taskList && (opts.taskList = taskList);

            //** execute the tasklist
            this.workflow.execute(name, version, data, opts).done();
        }

        return def.promise;
    }.bind(this);
};
util.inherits(workflo, events.EventEmitter);
