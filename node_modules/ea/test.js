'use strict';

var each = require('./');
var assert = require('assert');

var user = {
  name: 'Petr',
  age: 25
};

describe('each(obj, fn)', function() {
  it('should return index', function() {
    var vals = [];

    each(user, function(val, key) {
      vals.push(key);
    });

    assert.deepEqual(['name', 'age'], vals);
  });

  it('should return key/value pairs', function() {
    var vals = [];

    each(user, function(val, key) {
      vals.push([key, val]);
    });

    assert.deepEqual([['name', 'Petr'], ['age', 25]], vals);
  });
});

var cities = [
  'Moscow',
  'Peterburg',
  'Novgorod'
];

describe('each(arr, fn)', function() {
  it('should return index', function() {
    var vals = [];

    each(cities, function(val, i) {
      vals.push(i);
    });

    assert.deepEqual([0, 1, 2], vals);
  });

  it('should return values', function() {
    var vals = [];

    each(cities, function(val) {
      vals.push(val);
    });

    assert.deepEqual(['Moscow', 'Peterburg', 'Novgorod'], vals);
  });
});

var hello = 'hello';

describe('each(str, fn)', function() {
  it('should return values', function() {
    var vals = [];

    each(hello, function(val) {
      vals.push(val);
    });

    assert.deepEqual(['h', 'e', 'l', 'l', 'o'], vals);
  });
});
