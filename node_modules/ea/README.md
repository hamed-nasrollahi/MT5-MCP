# ea [![Build Status][travis-image]][travis-url]

  > Arrays, objects and strings iterator

  [each-reverse][each-reverse] - module for reverse iterations

## Install

```sh
npm install --save ea
```

```sh
component install andrepolischuk/ea
```

## API

### ea(array, fn)

  Iterate array

```js
ea([10, 11, 12], function(value, index) {

});
```

### ea(object, fn)

  Iterate object

```js
ea(user, function(value, key) {

});
```

### ea(string, fn)

  Iterate string

```js
ea('hello', function(value, key) {

});
```

## License

  MIT

[travis-url]: https://travis-ci.org/andrepolischuk/ea
[travis-image]: https://travis-ci.org/andrepolischuk/ea.svg?branch=master

[each-reverse]: https://github.com/andrepolischuk/each-reverse
