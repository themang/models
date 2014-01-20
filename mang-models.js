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
        if(schema.attributes) {
          Resource.prototype.validators = ValidatorFactory(schema.attributes, schema.type);
        }
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
  function anchorify(attrs) {
    var validations = {};
    for(var attr in attrs) {
      var validation = validations[attr] = {};
      var attrsVal = attrs[attr];

      if(typeof attrsVal === 'string')
        attrsVal = {type: attrsVal};

      for(var prop in attrsVal) {
        if(/^(defaultsTo|primaryKey|autoIncrement|unique|index|columnName)$/.test(prop)) continue;

        // use the Anchor `in` method for enums
        if(prop === 'enum') {
          validation['in'] = attrsVal[prop];
        }
        else {
          validation[prop] = attrsVal[prop];
        }
      }
    }
    return validations;
  }

  return function(attrs, types) {
    var validations = anchorify(attrs);
    anchor.define(types || {});

    var validators = {};
    _.each(validations, function(curValidation, name) {
      validators[name] = function(value, setValidity) {
        var requirements = anchor(curValidation);
        // Grab value and set to null if undefined
        if(typeof value == 'undefined') value = null;

        // If value is not required and empty then don't
        // try and validate it
        if(!curValidation.required) {
          if(value === null || value === '') 
            return;
        }

        // If Boolean and required manually check
        if(curValidation.required && curValidation.type === 'boolean') {
          if(value.toString() == 'true' || value.toString() == 'false') 
            return;
        }

        var ctrl = this
          , o = {};
        o[name] = value;
        _.each(requirements.data, function(req, key) {
          ctrl[name].$setValidity(key, true);
          if(typeof req !== 'function') return;
          requirements.data[key] = req.apply(o, []);
        });

        var err = anchor(value).to(requirements.data, o);
        if(err) {
          _.each(err, function(val, key) {
            ctrl[name].$setValidity(val.rule, false);
          });
        }
        
        return value;
      };
    });
    return validators;
  };
})
.directive('modelValidator', ['Models', function(Models) {
    return {
      require: ['form', '?modelForm'],
      link: function(scope, element, attrs, ctrls) {
        var form = ctrls[0]
          , modelForm = ctrls[1]
          , modelName = scope.$eval(attrs.modelValidator)
          , map = modelName
            ? Models.get(modelName).prototype.validators
            : modelForm.model.validators;

        _.each(map, function(val, key) {
          form[key] && form[key].$parsers.push(val.bind(form));
        });
      }
    }
}])
.directive('modelForm', ['Models', 'promiseStatus', 'WeoError', 
function(Models, promiseStatus, WeoError) {
  function Ctrl() {
    Emitter.call(this);

    this.status = {};
    this.errors = {};

    this.init = function(form, name) {
      this.form = form;
      this.model = _.isString(name) ? new (Models.get(name)) : name;      
      this.weoError = new WeoError(form);
    }

    this.action = function(action, options) {
      var self = this;
      var promise = this.status[action] = promiseStatus(this.model[action](options));
      promise.then(self.weoError.success(action), self.weoError.failure(action));
      promise.then(function() {
        self.emit(action);
      });
    };

    this.validate = function(action, options) {
      this.form.$valid && this.action(action, options);
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
  }
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
  }
}])