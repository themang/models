require('angular');
require('angular-resource');
require('angils');

var anchor = require('anchor')
  , _ = require('underscore')
  , Emitter = component('emitter')
  , util = require('util');

angular.module('mangModels', ['ngResource', 'angils',
  require('weo-error-codes')])
.factory('MangResource', function() {
  return function(Resource, schema) {
    var defaults = {};
    _.each(schema.attributes, function(attr, name) {
      if(attr.defaultsTo)
        defaults[name] = _.clone(attr.defaultsTo, true);
    });

    function MangResource(values) {
      Resource.call(this, _.extend(defaults, values))
    }
    _.extend(MangResource, Resource);
    util.inherits(MangResource, Resource);
    return MangResource;
  };
})
.factory('Models', ['ValidatorFactory', 'MangResource',
function(ValidatorFactory, MangResource) {
  var resources = {};
  var schemas = {};
  return {
    get: function(name) {
      var Resource = resources[name]
        , schema = schemas[name];

      if (Resource && !Resource.prototype.validators) {
        var schema = schemas[name];
        if (!schema) throw new Error('No schema called: ' + name);
        Resource.prototype.validators = ValidatorFactory(schema.attributes, schema.types);
      }
      return MangResource(Resource, schema);
    },
    add: function(name, resource) {
      resources[name] = resource;
      return this;
    },
    schemas: function(s) {
      _.extend(schemas, s);
      return this;
    }
  }
}])
.factory('ValidatorFactory', function() {
  var anchorSchema = require('anchor-schema');
  return function(attrs, types) {
    var validators = anchorSchema(attrs, types)
      , res = {};

    _.each(validators, function(fn, prop) {
      if(prop[0] !== '$') {
        res[prop] = function(value, model) {
          var ctrl = this;
          validators[prop](value, model, function(rule, valid) {
            ctrl[prop].$setValidity(rule, valid);
          });

          return value;
        };
      }
    });

    return res;
  };
})
.directive('modelValidator', ['Models', function(Models) {
    return {
      require: ['form', '?modelForm'],
      priority: 1000,
      link: function(scope, element, attrs, ctrls) {
        var form = ctrls[0]
          , modelForm = ctrls[1]
          , modelName = scope.$eval(attrs.modelValidator)
          , map = modelName
            ? Models.get(modelName).prototype.validators
            : modelForm.model.validators;

        function addValidator(fieldCtrl, validator) {
          if (fieldCtrl && validator) {
            fieldCtrl.$parsers.push(function(value) {
              return validator.call(form, value, modelForm.model);
            });
            // required needs to validate before changes
            if (validator.required && fieldCtrl.$isEmpty(fieldCtrl.$viewValue)) {
              fieldCtrl.$setValidity('required', false);
            }
          }
        }

        // add validators for current fields on form
        _.each(map, function(val, key) {
          var fieldCtrl = form[key];
          addValidator(fieldCtrl, val);
        });


        // add validators for future fields on form
        var addControl = form.$addControl;
        form.$addControl = function(control) {
          addControl.call(form, control);
          addValidator(control, map[control.$name]);
        }

        // TODO: remove validators on $removeControl?
      }
    }
}])
.directive('modelForm', ['Models', 'promiseStatus', 'WeoError', '$q',
function(Models, promiseStatus, WeoError, $q) {
  function Ctrl() {
    Emitter.call(this);

    this.status = {};
    this.errors = {};
    this.timeouts = {};
    this.debounces = {};

    this.init = function(form, name) {
      this.form = form;
      this.model = _.isString(name) ? new (Models.get(name)) : name;
      this.weoError = new WeoError(form);
    };

    this.action = function(action, options) {
      var self = this;
      var promise = this.status[action] = promiseStatus(this.model[action](options));
      promise.then(self.weoError.success(action), self.weoError.failure(action));
      promise.then(function() {
        self.emit(action);
      });
      return promise;
    };
  }

  util.inherits(Ctrl, Emitter);

  return {
    controller: Ctrl,
    require: ['modelForm', 'form'],
    priority: -10,
    link: function(scope, element, attrs, ctrls) {
      ctrls[0].init(ctrls[1], scope.$eval(attrs.modelForm));
      var name = attrs.modelFormCtrl || 'ModelForm';
      scope[name] = ctrls[0];
    }
  };
}])
.directive('modelHref', ['$location', function($location) {
  return {
    require:'^modelForm',
    link: function(scope, element, attrs, ctrl) {
      var parts = attrs.modelHref.split(' ')
        , e = parts[0]
        , href = parts[1];
      ctrl.on(e, function() {
        $location.path(href);
      });
    }
  };
}]);