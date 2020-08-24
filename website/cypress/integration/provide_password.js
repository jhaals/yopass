describe('Provide Password', function () {
  let polyfill;

  before(() => {
    const polyfillUrl = 'https://unpkg.com/unfetch/dist/unfetch.umd.js';

    cy.request(polyfillUrl).then((response) => {
      polyfill = response.body;
    });
  });

  beforeEach(() => {
    cy.server();
    cy.route({
      method: 'POST',
      url: '/secret',
      response: { message: '75c3383d-a0d9-4296-8ca8-026cc2272271' },
    }).as('post');

    cy.visit('/', {
      onBeforeLoad(win) {
        delete win.fetch;
        win.eval(polyfill);
        win.fetch = win.unfetch;
      },
    });
  });

  it('provide a password', () => {
    const secret = 'this is a test';
    const password = 'My$3cr3tP4$$w0rd';
    cy.get('textarea').type(secret);
    cy.get('#specify-password').click();
    cy.get('#password').type(password);
    cy.contains('Encrypt Message').click();
    cy.get('#full-i').should(
      'contain.value',
      'http://localhost:3000/#/c/75c3383d-a0d9-4296-8ca8-026cc2272271',
    );
    cy.get('#full-i').should(
      'contain.value',
      btoa(password)
    );
    cy.get('@post').should((req) => {
      console.log(req.request.body.message);
      cy.route({
        method: 'GET',
        url: '/secret/75c3383d-a0d9-4296-8ca8-026cc2272271',
        response: {
          message: req.request.body.message,
        },
      });
      expect(req.method).to.equal('POST');
      expect(req.request.body.expiration).to.equal(3600);
      expect(req.request.body.one_time).to.equal(true);
    });
    cy.get('#full-i')
      .invoke('val')
      .then((text) => {
        cy.visit(text);
        cy.contains(secret);
      });
  });
});
