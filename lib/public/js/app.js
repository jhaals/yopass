var app;
var app = angular.module('yopass', ['ngRoute']);

app.controller('createController', function($scope, $http, $location) {
  $scope.toggleoptions = function() {
    $scope.options = true;
  }
  $scope.save = function(s) {
    $http.post('/v1/secret', {secret: s.secret, lifetime: s.lifetime})
      .success(function(data, status, headers, config) {
        $scope.error = false;
        var base_url = window.location.protocol+"//"+window.location.host+"/#/s/";
        $scope.full_url = base_url+data.key+"/"+data.decryption_key;
        $scope.secret = null; //clear secret on success
        $scope.short_url = base_url+data.key;
        $scope.decryption_key = data.decryption_key;
      })
      .error(function(data, status, headers, config) {
        $scope.error = data.message
      });
  };
});

app.controller('ViewController', function($scope, $routeParams, $http) {
  function getSecret($key, $decryption_key) {
    $http.get('/v1/secret/'+$routeParams.key+'/'+$decryption_key)
      .success(function(data, status, headers, config) {
        $scope.errorMessage = false;
        $scope.invalidPassword = false;
        $scope.secret = data.secret;
      })
      .error(function(data, status, headers, config) {
        if(status == 401) {
          $scope.invalidPassword = true;
          return;
        }
        $scope.invalidPassword = false;
        $scope.errorMessage = true;
        $scope.display_form = false;
      });
  };
  if ($routeParams.decryption_key) {
    getSecret($routeParams.key,$routeParams.decryption_key);
  } else {
    $scope.display_form = true;
    $scope.view = function(form) {
      getSecret($routeParams.key, form.decryption_key);
    };
  };
});

app.config(function($routeProvider, $locationProvider) {
  $routeProvider
   .when('/s/:key/:decryption_key', {
    templateUrl: 'display-secret.html',
    controller: 'ViewController',
  })
  .when('/s/:key', {
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