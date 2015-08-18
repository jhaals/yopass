var app = angular.module('yopass', ['ngRoute', 'ngCookies']);

function randomString() {
    var text = "";
    var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for(var i=0; i < 16; i++)
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    return text;
}


app.controller('createController', function($scope, $http, $cookies) {
  $scope.close = function(s) { $scope.full_url = undefined; }
  $scope.save = function(s) {
    if (s === undefined) {
      return;
    }
    if(s.expiration === undefined) {
      s.expiration = 3600;
    }
    var decryption_key = randomString();
    encrypted = CryptoJS.AES.encrypt(s.secret, decryption_key);

    $http.post('/secret', {secret: encrypted.toString(), expiration: parseInt(s.expiration)})
      .success(function(data, status, headers, config) {
        $scope.error = false; //clear errors on success
        $scope.secret = null; //clear secret on success
        base_url = window.location.protocol+"//"+window.location.host+"/#/s/";
        $scope.full_url = base_url+data.key+"/"+decryption_key;
        $scope.short_url = base_url+data.key;
        $scope.decryption_key = decryption_key;
        /*
        msgs = $cookies.getObject('storedMessages');
        if (msgs === undefined) {
          $cookies.putObject('storedMessages', [{key: data.key, viewed: false}]);
          return;
        } else {
          msgs.push({key: data.key, viewed: false});
          $cookies.putObject('storedMessages', msgs);
        }
        */
      })
      .error(function(data, status, headers, config) {
        $scope.error = data.message
      });
  };
});

/*
app.controller('statusController', function($scope, $http, $cookies, $interval) {
  messages = $cookies.getObject('storedMessages');
});
*/

app.controller('ViewController', function($scope, $routeParams, $http) {
  function getSecret($key, $decryption_key) {
    $http.get('/secret/'+$routeParams.key)
      .success(function(data, status, headers, config) {
        $scope.display_form = false;
        var secret = CryptoJS.AES.decrypt(data.secret, $decryption_key).toString(CryptoJS.enc.Utf8);
        if(secret == "") {
          $scope.errorMessage = true;
          return;
        }
        $scope.secret = secret;
      })
      .error(function(data, status, headers, config) {
        $scope.errorMessage = true;
        $scope.display_form = false;
      });
  };

  if ($routeParams.decryption_key) {
    getSecret($routeParams.key, $routeParams.decryption_key);
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
