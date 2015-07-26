#Workflo.js

>Workflo.js is a schema-based framework, based on the AWS SWF SDK, for easily defining and executing your workflows  

Workflo.js simplifies the process of using the [AWS Simple Workflow Service](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/SWF.html), **SWF**, with Node.js by providing a framework for defining your _workflows_ and their _tasks_ using a JSON schema.  Workflo automatically handles registration and validation via the SWF API, and provides a base implementation for your _workers_ and _deciders_ which handles the core orchestration logic for making decisions, running tasks, and handling failures.  This allows you to focus development on your _workflows_ and _tasks_, from the start.


###What is the AWS Simple Workflow Service?

The [AWS Simple Workflow Service](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/SWF.html) is a webservice that allows you to define [_workflows_](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dev-about-workflows.html), which are comprised of [_tasks_](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dev-tasks.html), that represent processes within your business/organization/stack.  These processes can be API calls, database calls, shell scripts, whatever; you define how each task is handled via code.

These workflows are triggered remotely via the SWF API, which then defers to your servers for queue-based distributed execution in a manner that supports retry, failover, multiple outcomes, etc. at both the _task_ and _workflow_ level.  

The execution is handled by processes called [_Workers_](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dg-develop-activity.html) and [_Deciders_](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dg-dev-deciders.html).  A _Worker_ or _Decider_ is simply a Node.js process that you define, which connects to SWF via HTTP, and, using a [standard long-poll method](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dev-comm-proto.html), listens for the next action to process, or decision to make.

A great part about SWF is the fact that the _Workers_ or _Deciders_ are just processes; there is no limit to how many you can have, where they are located, what sort of hardware they run on...you can even define which _Workers_ handle which _workflows_/_tasks_ if needed.  This allows you to easily isolate the processing of certain workflows or tasks to one part of your infrastructure, maybe based on specific CPU/Memory/Compliance needs, while running the rest in another part.  

This saves a lot of boilerplate development for configuring and maintaining message queues, defining and orchestrating async processes distributed across multiple machines, executing tasks vs making decisions in a reliable and redundant manner,  providing failover and retry mechanisms, etc.

One thing to keep in mind is that each _Worker_ or _Decider_ must be stateless; this is because each decision and task execution could potentially be handled by a different _Decider_ or _Worker_ (ie, a process on another machine) than the previous.

Another thing to keep in mind, is that due to the nature of how these tasks are executed, its usually not a good idea to put waiting for the completion of a workflow in the critical path of a response to a client's web request; workflows are intended to supplement processes that are able to be deferred, can fail and be retried if necessary, multiple times, and generally occur "behind the scenes".



###Enough words, show me code
```
//** workflows can be defined in multiple files, contain multiple definitions, etc
Workflo.define('handle-website-order', {

    //** defines the workflows meta-data that will be registered with the SWF API
    swf: {
        description: 'after we charge the users card, we send them a receipt and add them to our mailing list'
    },

    //** defines the tasks meta-data
    tasks: [
        { 
            name: 'generate-pdf',
            description: 'generates a pdf of the order receipt, returns url'
        },

        { 
            name: 'send-receipt',
            description: 'sends the user a receipt with a link to the pdf'
        },

        {
            name: 'add-to-mailing-list',
            description: 'adds the user to our mailing list'
        }
    ],

    //** defines the tasks handlers, by task name
    handlers: {
        'generate-pdf': function(task) {
            var orderId = task.data.orderId;

            someLibrary.generatePdf(orderId)
                .then(function(url) {
                    //** pass the url of the generated pdf to the next task
                    task.complete({ pdfUrl: url });
                })
                .catch(task.fail);

            //** this task is asynchronous
            return task.async();
        },

        'send-receipt': function(task) {
            var email = task.data.email,
                pdfUrl = task.data.pdfUrl;

            if(!someLibrary.sendEmail(email, pdfUrl))
                return task.fail({ reason: 'failed to send the email' });
        
            task.complete();
        },

        'add-to-mailing-list': function(task) {
            var email = task.data.email;

            //** complete the workflow when this promise resolves, otherwise fail the task and allow it to be retried
            anotherLibrary.addEmailToMailList(email)
                .then(task.completeWorkflow)
                .catch(function(err) {
                    return task.fail(err);
                };
        
            return task.async();
        }
    }
});


//** run the workflow with a data context
Workflow.run('handle-website-order', {
    orderId: 'foobar123',
    email: 'user@foobar.com'
});

```

in progress...
