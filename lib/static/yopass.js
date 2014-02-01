$(document)
  .ready(function() {
    $('.ui.radio.checkbox')
      .checkbox();
$('.ui.form')
  .form({
    secret: {
      identifier: 'secret',
      rules: [
        {
          type: 'empty',
          prompt: "Secret required"
        },
        {
          type   : 'maxLength[10000]',
          prompt : 'This website is for secrets, not novels'
        }
      ]
    },
  })
;
  })
;