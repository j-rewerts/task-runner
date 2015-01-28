goog.provide('taskrunner.DependencyGraphTask');

goog.require('goog.array');
goog.require('taskrunner.AbstractTask');



/**
 * Executes of a set of interdependent Tasks in the appropriate order to satisfy
 * all blocking dependencies. This task will complete once all child tasks
 * complete or error when a child task fails. In the event of an error, no
 * additional tasks will be run until this task has been told to resume.
 *
 * @param {string=} opt_taskName Optional semantically meaningful task name.
 * @extends {taskrunner.AbstractTask}
 * @constructor
 * @struct
 */
taskrunner.DependencyGraphTask = function(opt_taskName) {
  goog.base(this, opt_taskName);

  /** @private {!Object} */
  this.taskIdToDependenciesMap_ = {};

  /** @private {!Array.<!taskrunner.Task>} */
  this.tasks_ = [];

  /** @private {!Array.<!taskrunner.Task>} */
  this.erroredTasks_ = [];
};
goog.inherits(taskrunner.DependencyGraphTask, taskrunner.AbstractTask);


/**
 * Adds a child task to the dependency graph and ensures that its blocking
 * dependencies (if any) are valid.
 *
 * @param {!taskrunner.Task} task Child task to be run when this task is run.
 * @param {Array.<!taskrunner.Task>=} blockers Blocking tasks that must complete
 *     successfully before this task can be run. This parameter can be ommitted
 *     for tasks that do not have blocking dependencies.
 * @return {!taskrunner.DependencyGraphTask} a reference to the current task.
 * @throws {Error} if task has been added more than once.
 * @throws {Error} if cyclic dependencies are detected.
 */
taskrunner.DependencyGraphTask.prototype.addTask = function(task, blockers) {
  var index = this.tasks_.indexOf(task);

  goog.asserts.assert(index < 0, 'Cannot add task more than once.');

  this.tasks_.push(task);
  this.taskIdToDependenciesMap_[task.getUniqueID()] = blockers;

  this.validateDependencies_(task);

  if (this.getState() == taskrunner.TaskState.RUNNING) {
    this.runAllReadyTasks_();
  }

  return this;
};


/**
 * Removes a child task from the dependency graph and ensures that the remaining
 * dependencies are still valid.
 *
 * @param {!taskrunner.Task} task Child task to be removed from the graph.
 * @return {!taskrunner.DependencyGraphTask} a reference to the current task.
 * @throws {Error} if the task provided is not within the depenency graph, or if
 *     removing the task invalidates any other, blocked tasks.
 */
taskrunner.DependencyGraphTask.prototype.removeTask = function(task) {
  var index = this.tasks_.indexOf(task);

  goog.asserts.assert(index >= 0, 'Cannot find the specified task.');

  this.removeCallbacksFrom_(task);

  this.tasks_.splice(this.tasks_.indexOf(task), 1);

  delete this.taskIdToDependenciesMap_[task.getUniqueID()];

  for (var i in this.tasks_) {
    this.validateDependencies_(this.tasks_[i]);
  }

  if (this.getState() == taskrunner.TaskState.RUNNING) {
    this.completeOrRunNext_();
  }

  return this;
};


/**
 * @inheritDoc
 */
taskrunner.DependencyGraphTask.prototype.getOperationsCount = function() {
  var operationsCount = 0;

  goog.array.forEach(this.tasks_, function(task) {
    operationsCount += task.getOperationsCount();
  });

  return operationsCount;
};


/**
 * @inheritDoc
 */
taskrunner.DependencyGraphTask.prototype.getCompletedOperationsCount =
    function() {
  var completedOperationsCount = 0;

  goog.array.forEach(this.tasks_, function(task) {
    completedOperationsCount += task.getCompletedOperationsCount();
  });

  return completedOperationsCount;
};


/** @override */
taskrunner.DependencyGraphTask.prototype.runImpl = function() {
  this.erroredTasks_ = [];

  this.completeOrRunNext_();
};


/** @override */
taskrunner.DependencyGraphTask.prototype.interruptImpl = function() {
  for (var i in this.tasks_) {
    var task = this.tasks_[i];

    if (task.getState() == taskrunner.TaskState.RUNNING) {
      this.removeCallbacksFrom_(task);

      task.interrupt();
    }
  }
};


/** @override */
taskrunner.DependencyGraphTask.prototype.resetImpl = function() {
  this.erroredTasks_ = [];

  goog.array.forEach(this.tasks_, function(task) {
    task.reset();
  });
};


/**
 * Add callbacks to the specified task.
 *
 * @param {!taskrunner.Task} task Child task
 * @private
 */
taskrunner.DependencyGraphTask.prototype.addCallbacksTo_ = function(task) {
  task.completed(this.childTaskCompleted_, this);
  task.errored(this.childTaskErrored_, this);
};


/**
 * Add callbacks from the specified task.
 *
 * @param {!taskrunner.Task} task Child task
 * @private
 */
taskrunner.DependencyGraphTask.prototype.removeCallbacksFrom_ = function(task) {
  task.off(taskrunner.TaskEvent.COMPLETED, this.childTaskCompleted_, this);
  task.off(taskrunner.TaskEvent.ERRORED, this.childTaskErrored_, this);
};


/**
 * @return {boolean} All child tasks have completed.
 * @private
 */
taskrunner.DependencyGraphTask.prototype.areAllTasksCompleted_ = function() {
  for (var i in this.tasks_) {
    if (this.tasks_[i].getState() != taskrunner.TaskState.COMPLETED) {
      return false;
    }
  }

  return true;
};


/**
 * @return {boolean} At least one child task is running.
 * @private
 */
taskrunner.DependencyGraphTask.prototype.isAnyTaskRunning_ = function() {
  for (var i in this.tasks_) {
    if (this.tasks_[i].getState() == taskrunner.TaskState.RUNNING) {
      return true;
    }
  }

  return false;
};


/**
 * Checks the specified task to ensure that it does not have any cyclic
 * dependencies (tasks that are mutually dependent) or dependencies on tasks
 * that are not in the current graph.
 *
 * @param {!taskrunner.Task} task Child task
 * @throws {Error} if cyclic or invalid dependencies are detected.
 * @private
 */
taskrunner.DependencyGraphTask.prototype.validateDependencies_ = function(
    task) {

  var blockers = this.taskIdToDependenciesMap_[task.getUniqueID()];

  if (blockers) {

    // Task cannot depend on itself
    goog.asserts.assert(blockers.indexOf(task) < 0,
        'Cyclic dependency detected.');

    for (var i in blockers) {
      var blocker = blockers[i];

      // Blocking task must be within the graph
      goog.asserts.assert(this.tasks_.indexOf(blocker) >= 0,
          'Invalid dependency detected.');
    }
  }
};


/**
 * Check child tasks to see if the graph has completed or errored.
 * If not, this method will run the next task(s).
 *
 * @private
 */
taskrunner.DependencyGraphTask.prototype.completeOrRunNext_ = function() {
  if (this.areAllTasksCompleted_()) {
    this.completeInternal();
  } else if (this.erroredTasks_.length == 0) {
    this.runAllReadyTasks_();
  } else if (!this.isAnyTaskRunning_()) {
    this.errorInternal();
  }
};


/**
 * Determines if a task is safe to run by analyzing its blocking dependencies.
 *
 * @param {!taskrunner.Task} task Child task
 * @return {boolean} The specified task has incomplete blocking tasks.
 * @private
 */
taskrunner.DependencyGraphTask.prototype.hasIncompleteBlockers_ =
    function(task) {

  var blockers = this.taskIdToDependenciesMap_[task.getUniqueID()];

  if (blockers) {
    for (var i in blockers) {
      var blockingTask = blockers[i];

      if (blockingTask.getState() != taskrunner.TaskState.COMPLETED) {
        return true;
      }
    }
  }

  return false;
};


/**
 * Run every non-running task that is not blocked by another incomplete task.
 *
 * @private
 */
taskrunner.DependencyGraphTask.prototype.runAllReadyTasks_ = function() {
  for (var i in this.tasks_) {
    var task = this.tasks_[i];

    // TRICKY: If a task synchronously completes it will lead to another,
    // simultaneous invocation of this method. If this 2nd invocation starts a
    // task that synchronously errors, we run the risk of re-executing that
    // failed Task when we return to this method. To avoid this, check to make
    // sure that the Task we are examining has not already errored. Don't rely
    // on task.getState() to check for an error, because it may have errored on
    // a previous run in which case we should retry it now.
    if (this.erroredTasks_.indexOf(task) >= 0) {
      continue;
    }

    if (this.hasIncompleteBlockers_(task)) {
      continue;
    }

    if (task.getState() != taskrunner.TaskState.RUNNING &&
       task.getState() != taskrunner.TaskState.COMPLETED) {
      this.addCallbacksTo_(task);

      task.run();
    }
  }
};


/**
 * Callback for child task completions.
 *
 * @param {!taskrunner.Task} task Task that has just completed.
 * @private
 */
taskrunner.DependencyGraphTask.prototype.childTaskCompleted_ = function(task) {
  this.removeCallbacksFrom_(task);

  this.completeOrRunNext_();
};


/**
 * Callback for child task errors.
 *
 * @param {!taskrunner.Task} task Task that has just errored.
 * @private
 */
taskrunner.DependencyGraphTask.prototype.childTaskErrored_ = function(task) {
  this.removeCallbacksFrom_(task);

  this.erroredTasks_.push(task);

  this.completeOrRunNext_();
};

