#Workflo.js

>Workflo.js is a schema-based framework, based on the AWS SDK, for defining and executing your AWS SWF workflows  

Workflo.js simplifies the process of using the [AWS Simple Workflow Service](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/SWF.html), **SWF**, by providing a framework for defining your _workflows_ and their _tasks_ using a JSON schema.  Workflo automatically handles registration and validation of these via the SWF API, and provides a base implementation for your _workers_ and _deciders_ which handles the core orchestration logic, allowing you to focus your development on your _workflows_ and _tasks_, from the start.

###Wait, show me something first

```
var 
```

###What is the AWS Simple Workflow Service?

The [AWS Simple Workflow Service](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/SWF.html), **SWF**, is a webservice that allows you to define [_workflows_](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dev-about-workflows.html), which are comprised of [_tasks_](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dev-tasks.html), that represent processes within your business/organization/stack.  

These workflows are triggered remotely via the **SWF** API, which orchestrates your servers for distributed execution in a manner that supports retry, failover, multiple outcomes, etc. at both the _task_ and _workflow_ level, which is pretty powerful.

The execution is handled on your servers by processes called [_Workers_](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dg-develop-activity.html) and [_Deciders_](http://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-dg-dev-deciders.html).  A _Worker_ or _Decider_ is simply a process that you define, which connects to **SWF** via HTTP, and, using a standard long-poll method, listens for the next action to process, or decision to make.

The true power of **SWF** is in the fact that the _Workers_ or _Deciders_ are just processes; there is no limit to how many you can have, where they are located, what sort of hardware they run on...you can even define which _Workers_ handle which _workflows_ if needed.  The **only** rule that you need to follow is that each _Worker_ or _Decider_ must be stateless.  This makes scaling to your workload pretty easy.


Processes can be anything, from performing a multi-step data operation like charging a credit card
