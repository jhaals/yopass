describe('Upload/Download File', () => {
  beforeEach(() => {
    cy.visit('#/upload');
    cy.intercept('POST', 'http://localhost:3000/file', {
      headers: { 'content-type': 'application/json' },
      body: { message: '75c3383d-a0d9-4296-8ca8-026cc2272271' },
    }).as('post');
  });

  const linkSelector = '.MuiTableBody-root > :nth-child(1) > :nth-child(3)';
  it('upload file', () => {
    const yourFixturePath = 'data.txt';
    cy.get('input').attachFile(yourFixturePath);
    cy.get(linkSelector).should(
      'contain',
      'http://localhost:3000/#/f/75c3383d-a0d9-4296-8ca8-026cc2272271',
    );
    cy.wait('@post').then(mockGetResponse);

    cy.get(linkSelector)
      .invoke('text')
      .then((text) => {
        cy.visit(text);
        cy.contains('File downloaded');
        // File downloads not supported in headless mode.
        // https://github.com/cypress-io/cypress/issues/949
        cy.readFile('cypress/downloads/data.txt').then((f) => {
          expect(f).to.equal('hello world');
        });
      });
  });

  it('upload file with custom password', () => {
    cy.get('input[name=generateDecryptionKey]').click(); // specify password
    const password = 'My$3cr3tP4$$w0rd';
    cy.get('#password').type(password);
    cy.get('input').attachFile('data.txt');
    cy.get(linkSelector).should(
      'contain',
      'http://localhost:3000/#/f/75c3383d-a0d9-4296-8ca8-026cc2272271',
    );
    cy.wait('@post').then(mockGetResponse);

    cy.get(linkSelector)
      .invoke('text')
      .then((text) => {
        cy.visit(text);
        cy.get('input').type(password);
        cy.contains('Decrypt secret').click();
        cy.contains('File downloaded');
        // File downloads not supported in headless mode.
        // https://github.com/cypress-io/cypress/issues/949
        cy.readFile('cypress/downloads/data.txt').then((f) => {
          expect(f).to.equal('hello world');
        });
      });
  });
});

// Take encrypted message from POST request and mock GET request with message.
const mockGetResponse = (intercept) => {
  const body = JSON.parse(intercept.request.body);
  expect(body.expiration).to.equal(3600);
  expect(body.one_time).to.equal(true);
  cy.intercept(
    'GET',
    'http://localhost:3000/file/75c3383d-a0d9-4296-8ca8-026cc2272271',
    {
      body: { message: body.message },
    },
  );
};
