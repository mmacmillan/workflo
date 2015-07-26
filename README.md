#Workflo.js

>Workflo.js is a schema-based framework, based on the AWS SWF SDK, for easily defining, registering, and executing your workflows


###What is the AWS Simple Workflow Service?

[(I am already familiar with this stuff...)](#What-does-Workflo.js-do)

The [AWS Simple Workflow Service](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/SWF.html), SWF, is a webservice that allows you to define [_Workflows_](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dev-about-workflows.html), which are comprised of [_Tasks_](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dev-tasks.html), that represent processes within your business/organization/stack.  

A processes may be registering a user with your system, charging a payment account, generating the thumbnails for an image or set of images and publishing them to a CDN, transcoding a video, aggregating log files...whatever.  If the process can be broken into individual _Tasks_, and would benefit from each task being executed in a reliable manner, then a _Workflow_ may be the right way to package it.

Your workflows are invoked via the SWF API, but the execution is handled your servers by [_Workers_](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dg-develop-activity.html) and [_Deciders_](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dg-dev-deciders.html).  A _Worker_ or _Decider_ is simply a Node.js process that you define, which connects to SWF via HTTP, and, using a [standard long-poll method](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dev-comm-proto.html), listens for the next action to process, or decision to make.

This design allows your _Workers_ and _Deciders_ to be very flexible; there is no limit to how many you can have, where they are located, what sort of hardware they run on; this can simplify scaling/adding more capacity, often reduced to just adding more _Workers_. 

You can also [define which _Workers_ handle which _Workflows_/_Tasks_](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dev-task-lists.html) if needed.  This allows you to easily isolate the processing of certain workflows or tasks to one part of your infrastructure, maybe based on specific CPU/Memory/Compliance needs, while running the rest in another part of your infrastructure.  

Using SWF, you can avoid extensive boilerplate development for configuring and maintaining message queues, defining and orchestrating task execution across multiple servers with failover and retry mechanisms...a lot of code.

###What does Workflo.js do?

Workflo.js simplifies the process of using the [AWS Simple Workflow Service](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/SWF.html), with Node.js by providing a framework for defining your _Workflows_ and their _Tasks_ using a JSON schema.  Workflo provides functionality for registering and validating these _Workflows_/_Tasks_ via the AWS SDK, and provides a base implementation for your _Workers_ and _Deciders_ which handles the core orchestration logic for making decisions, running tasks, and handling failures.  This allows you to focus development on your _Workflows_ and _Tasks_, from the start.


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
                });
        
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

###Ok, What's Next?
1. Install Workflo.js
> npm install workflo

1. If you haven't used the Simple Workflow Service before, you need to [register a domain](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dg-register-domain-console.html)
   - you [may use more than one domain](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dev-domain.html) if you're implementation calls for it, but you need at least one.
1. [Create an IAM User](http://docs.aws.amazon.com/IAM/latest/UserGuide/Using_SettingUpUser.html) to use specifically for SWF
   - Attach the policy "SimpleWorkflowFullAccess"
     - If those permissions don't work for you, [read this guide](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dev-iam.html) for configuring an IAM policy for SWF.
   - [Get the Access Key and Secret](http://docs.aws.amazon.com/IAM/latest/UserGuide/ManagingCredentials.html) for the SWF user
1. View the Documentation
1. Check out the Basic Example
1. Browse some additional examples
1. Using EC2?  Download an AMI that has this all already configured [here]()


