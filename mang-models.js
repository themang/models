require('angular');
require('angular-resource');

var component = require('lib/component');
var anchor = require('anchor')
  , _ = require('underscore')
  , Emitter = component('emitter')
  , util = require('util');

angular.module('mangModels', ['ngResource',
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
.provider('Models', function() {
  var _resources = {};
  var resources = {};
  // XXX This whole thing is kind of ugly, it just has to support a similar
  // interface to the old style
  this.add = function(name) {
    var args = _.toArray(arguments);
    _resources[name] = args.slice(1);
    return this;
  };

  this.$get = ['MangResource', function(MangResource) {
    return {
      get: function(name) {
        if(! resources[name])
          resources[name] = MangResource.apply(null, _resources[name]);
        return resources[name];
      }
    };
  }];
})
.factory('ValidatorFactory', function() {
  var anchorSchema = require('anchor-schema');
  return function(attrs, types) {
    var validators = anchorSchema(attrs, types)
      , res = {};

    _.each(validators, function(fn, prop) {
      if(prop[0] !== '$') {
        res[prop] = function(value, model, fieldCtrl) {
          var ctrl = this;
          validators[prop](value, model, function(rule, valid) {
            ctrl[fieldCtrl.$name].$setValidity(rule, valid);
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
.directive('modelForm', ['Models', 'promiseStatus', 'WeoError',
function(Models, promiseStatus, WeoError) {
  function Ctrl() {
    Emitter.call(this);

    this.status = {};
    this.errors = {};

    this.init = function(form, nameOrModel, allowConcurrent) {
      this.form = form;
      this.weoError = new WeoError(form);
      this.setModel(nameOrModel);
      this.allowConcurrent = allowConcurrent;
    };

    this.setModel = function(name) {
      this.model = _.isString(name) ? new (Models.get(name)) : name;
    };

    this.reset = function(nameOrModel) {
      this.form.$setPristine();
      this.setModel(nameOrModel);
    };

    this.ready = function(action) {
      return !this.status[action] || !this.status[action].loading;
    };

    this.action = function(action, options) {
      if(this.allowConcurrent.indexOf(action) === -1 && ! this.ready(action))
        return;

      var self = this;
      var promise = this.status[action] = promiseStatus(this.model[action](options));
      promise.then(self.weoError.success(action), self.weoError.failure(action))
      ['catch'](function(err) {
        self.emit('action-error', action, err);
      });
      promise.then(function(res) {
        self.emit(action, res);
      });
      return promise;
    };

    this.addValidator = function(fieldCtrl, validator, form) {
      addValidator(fieldCtrl, validator, form, this.model);
    };
  }

  util.inherits(Ctrl, Emitter);

  return {
    controller: Ctrl,
    require: ['modelForm', 'form'],
    priority: -10,
    link: function(scope, element, attrs, ctrls) {
      var modelForm = ctrls[0];
      var form = ctrls[1];
      var allowConcurrent = scope.$eval(attrs.allowConcurrent || '');

      modelForm.init(form, scope.$eval(attrs.modelForm),
        [].concat(allowConcurrent).filter(Boolean));
      var name = attrs.modelFormCtrl || 'ModelForm';
      scope[name] = modelForm;
    }
  };
}])
.directive('fieldValidate', ['ValidatorFactory', function(ValidatorFactory) {
  var idx = 0;
  return {
    require: ['ngModel', '^form', '?^modelForm'],
    link: function(scope, element, attr, ctrls) {
      var fieldCtrl = ctrls[0];
      var form = ctrls[1];
      var modelForm = ctrls[1];

      var schema = {};
      var attribute = scope.$eval(attr.fieldValidate);
      idx++;
      schema[idx] = attribute;
      var validators = ValidatorFactory(schema);
      addValidator(fieldCtrl, validators[idx], form, modelForm && modelForm.model);
    }
  }
}])
.directive('modelAction', ['$location', function($location) {
  return {
    require: '^modelForm',
    link: function(scope, element, attrs, ctrl) {
      var hash = scope.$eval(attrs.modelAction);
      _.each(hash, function(action, evt) {
        ctrl.on(evt, function(res) {
          var path = action[0] === '/'
            ? action
            : scope.$eval(action, {res: res});

          path && $location.path(path);
        });
      });
    }
  };
}]);

function addValidator(fieldCtrl, validator, form, self) {
  self = self || {};
  if (fieldCtrl && validator) {
    fieldCtrl.$parsers.push(function(value) {
      return validator.call(form, value, self, fieldCtrl);
    });
    // required needs to validate before changes
    if (validator.required && fieldCtrl.$isEmpty(fieldCtrl.$viewValue)) {
      fieldCtrl.$setValidity('required', false);
    }
  }
}
