require('angular');
require('angular-resource');
require('angils');

var component = require('lib/component');
var anchor = require('anchor')
  , _ = require('underscore')
  , Emitter = component('emitter')
  , util = require('util');

angular.module('mangModels', ['ngResource', 'angils',
  require('weo-error-codes')])
.factory('MangResource', ['$resource', 'ValidatorFactory', '$http',
function($resource, ValidatorFactory, $http) {
  return function(server, base, schema, opts, methods) {
    var defaults = {};
    if(schema && schema.attributes) {
      _.each(schema.attributes, function(attr, name) {
        if(attr.defaultsTo)
          defaults[name] = _.clone(attr.defaultsTo, true);
      });
    }

    // Strip the slashes on either side of our
    // path components so that we can .join('/')
    // without having duplicate slashes
    function stripSlashes(str) {
      var start = 0, end = str.length - 1;
      while(str[start] === '/')
        start++;
      while(str[end] === '/')
        end--;
      return str.slice(start, end + 1);
    }

    function buildUrl(path) {
      path = path || '';
      var parts = [server];
      if(!path || path[0] !== '/')
        parts.push(base);

      path && parts.push(path);
      return parts.map(stripSlashes).join('/');
    }

    _.each(methods, function(descriptor, name) {
      descriptor.url = buildUrl(descriptor.url);
      var transforms = [].concat(descriptor.transformResponse || [])
        , complete = [].concat(descriptor.complete || []);

      transforms = transforms.concat($http.defaults.transformResponse);
      transforms = transforms.concat(complete.map(function(fn) {
        return function(data) {
          fn.apply(this, arguments);
          return data;
        };
      }));

      delete descriptor.complete;
      descriptor.transformResponse = transforms;
    });

    var Resource = $resource(server + '/' + base + '/', opts, methods);

    function MangResource(values) {
      Resource.call(this, _.defaults(values || {}, defaults));
    }

    _.extend(MangResource, Resource);
    util.inherits(MangResource, Resource);
    Emitter(MangResource);
    if(schema && schema.attributes)
      Resource.prototype.validators = ValidatorFactory(schema.attributes, schema.types);
    return MangResource;
  };
}])
.factory('Models', ['ValidatorFactory', 'MangResource',
function(ValidatorFactory, MangResource) {
  var resources = {};
  var schemas = {};
  return {
    get: function(name) {
      return resources[name];
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
        res[prop].required = validators[prop].required;
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

        // add validators for current fields on form
        _.each(map, function(val, key) {
          var fieldCtrl = form[key];
          modelForm.addValidator(fieldCtrl, val, form);
        });

        // add validators for future fields on form
        var addControl = form.$addControl;
        form.$addControl = function(control) {
          addControl.call(form, control);
          modelForm.addValidator(control, map[control.$name], form);
        };

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

    this.init = function(form, nameOrModel) {
      this.form = form;
      this.weoError = new WeoError(form);
      this.setModel(nameOrModel);
    };

    this.setModel = function(name) {
      this.model = _.isString(name) ? new (Models.get(name)) : name;
    };

    this.reset = function(nameOrModel) {
      this.form.$setPristine();
      this.setModel(nameOrModel);
    };

    this.action = function(action, options) {
      var self = this;
      var promise = this.status[action] = promiseStatus(this.model[action](options));
      promise.then(self.weoError.success(action), self.weoError.failure(action));
      promise.then(function(res) {
        self.emit(action, res);
      });
      return promise;
    };

    this.addValidator = function(fieldCtrl, validator, form) {
      var self = this;
      if (fieldCtrl && validator) {
        fieldCtrl.$parsers.push(function(value) {
          return validator.call(form, value, self.model);
        });
        // required needs to validate before changes
        if (validator.required && fieldCtrl.$isEmpty(fieldCtrl.$viewValue)) {
          fieldCtrl.$setValidity('required', false);
        }
      }
    }
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
.directive('fieldValidate', ['ValidatorFactory', function(ValidatorFactory) {
  return {
    require: ['ngModel', '^form', '^modelForm'],
    link: function(scope, element, attr, ctrls) {
      var fieldCtrl = ctrls[0];
      var form = ctrls[1];
      var modelForm = ctrls[2];

      var schema = {};
      var attribute = scope.$eval(attr.fieldValidate);
      schema[fieldCtrl.$name] = attribute;
      var validators = ValidatorFactory(schema);
      modelForm.addValidator(fieldCtrl, validators[fieldCtrl.$name], form);
    }
  }
}])
.directive('modelAction', ['$location', function($location) {
  return {
    require: '^modelForm',
    link: function(scope, element, attrs, ctrl) {
      var hash = scope.$eval(attrs.modelAction);
      _.each(hash, function(action, evt) {
        ctrl.on(evt, function() {
          var path = action[0] === '/'
            ? action
            : scope.$eval(action);

          path && $location.path(path);
        });
      });
    }
  };
}]);
