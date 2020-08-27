describe('Upload/Download File', function () {
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
      url: '/file',
      response: { message: '75c3383d-a0d9-4296-8ca8-026cc2272271' },
    }).as('post');

    cy.visit('#/upload', {
      onBeforeLoad(win) {
        delete win.fetch;
        win.eval(polyfill);
        win.fetch = win.unfetch;
      },
    });
  });

  it('upload file', () => {
    const yourFixturePath = 'data.txt';
    cy.get('input').attachFile(yourFixturePath);
    cy.get('#full-i').should(
      'contain.value',
      'http://localhost:3000/#/f/75c3383d-a0d9-4296-8ca8-026cc2272271',
    );
    cy.get('@post').should((req) => {
      cy.route({
        method: 'GET',
        url: '/file/75c3383d-a0d9-4296-8ca8-026cc2272271',
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
        cy.contains(
          'Downloading file and decrypting in browser, please hold...',
        );
        // File downloads not supported in headless mode.
        // https://github.com/cypress-io/cypress/issues/949
        cy.readFile('cypress/downloads/data.txt').then((f) => {
          expect(f).to.equal('hello world');
        });
      });
  });

  it('upload file with custom password', () => {
    cy.get('#specify-password').click();
    const password = 'My$3cr3tP4$$w0rd';
    cy.get('#password').type(password);
    cy.get('input').attachFile('data.txt');
    cy.get('#short-i').should(
      'contain.value',
      'http://localhost:3000/#/d/75c3383d-a0d9-4296-8ca8-026cc2272271',
    );
    cy.get('@post').should((req) => {
      cy.route({
        method: 'GET',
        url: '/file/75c3383d-a0d9-4296-8ca8-026cc2272271',
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
        cy.contains(
          'Downloading file and decrypting in browser, please hold...',
        );
        // File downloads not supported in headless mode.
        // https://github.com/cypress-io/cypress/issues/949
        cy.readFile('cypress/downloads/data.txt').then((f) => {
          expect(f).to.equal('hello world');
        });
      });
  });
});
