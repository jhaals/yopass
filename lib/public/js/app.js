var app;
var app = angular.module('yopass', ['ngRoute']);

app.directive('features', function() {
  return {
    restrict: 'E',
    templateUrl: 'view-secret.html'
  };
});

app.controller('createController', function($scope, $http, $location) {
  $scope.save = function(s) {
    $scope.master = {};
    $http.post('/v1/secret', {secret: s.secret, lifetime: s.lifetime})
      .success(function(data, status, headers, config) {
        $scope.error = false;
        $scope.full_url = data.full_url;
        $scope.secret = null; //clear secret on success
        $scope.short_url = data.short_url;
        $scope.decryption_key = data.decryption_key;
      })
      .error(function(data, status, headers, config) {
        $scope.error = data.message
      });
  };
});

app.controller('ViewController', function($scope, $routeParams, $http) {
  $http.get('/v1/secret/'+$routeParams.key+'/'+$routeParams.decryption_key)
    .success(function(data, status, headers, config) {
      alert(data);
    })
    .error(function(data, status, headers, config) {
      $scope.error = data.message
    });
});

app.config(function($routeProvider, $locationProvider) {
  $routeProvider
   .when('/s/:key/:decryption_key', {
    templateUrl: 'display-secret.html',
    controller: 'ViewController',
  })
  .when('/create', {
    templateUrl: 'create-secret.html',
    controller: 'createController'
  })
  .otherwise({
    redirectTo: '/create'
  });
});