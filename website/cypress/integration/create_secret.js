describe('Create Secret', () => {
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

  it('create secret', () => {
    cy.get('textarea').type('hello world');
    cy.contains('Encrypt Message').click();
    cy.get('#full-i').should(
      'contain.value',
      'http://localhost:3000/#/s/75c3383d-a0d9-4296-8ca8-026cc2272271',
    );
    cy.get('@post').should((req) => {
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
        cy.contains('hello world');
      });
  });

  it('create secret with custom password', () => {
    const secret = 'this is a test';
    const password = 'My$3cr3tP4$$w0rd';
    cy.get('textarea').type(secret);
    cy.get('#specify-password').click();
    cy.get('#password').type(password);
    cy.contains('Encrypt Message').click();
    cy.get('#short-i').should(
      'contain.value',
      'http://localhost:3000/#/c/75c3383d-a0d9-4296-8ca8-026cc2272271',
    );
    cy.get('@post').should((req) => {
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
    cy.get('#short-i')
      .invoke('val')
      .then((text) => {
        cy.visit(text);
        cy.get('input').type(password);
        cy.get('.btn').click();
        cy.contains(secret);
      });
  });
});
