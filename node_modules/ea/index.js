'use strict';

try {
  var type = require('type');
} catch (err) {
  var type = require('component-type');
}

module.exports = function(obj, fn) {
  if (type(fn) !== 'function') return;

  switch (type(obj)) {
    case 'array':
      return array(obj, fn);
    case 'object':
      if (type(obj.length) === 'number') return array(obj, fn);
      return object(obj, fn);
    case 'string':
      return string(obj, fn);
  }
};

function array(obj, fn) {
  for (var i = 0, len = obj.length; i < len; i++) {
    fn(obj[i], i);
  }
}

function object(obj, fn) {
  for (var i in obj) {
    if (obj.hasOwnProperty(i)) {
      fn(obj[i], i);
    }
  }
}

function string(obj, fn) {
  for (var i = 0, len = obj.length; i < len; i++) {
    fn(obj.charAt(i), i);
  }
}
