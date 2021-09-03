// TODO: Fix automated login with mock ElvID user login.
describe('Fix Create Secret', () => {
  it('Visits the Kitchen Sink', () => {
    cy.visit('https://example.cypress.io');
  });
});

/*
describe('Create Secret', () => {
  beforeEach(() => {
    cy.visit('/');
    cy.intercept('POST', 'http://localhost:3000/secret', {
      body: { message: '75c3383d-a0d9-4296-8ca8-026cc2272271' },
    }).as('post');
  });

  const linkSelector = '.MuiTableBody-root > :nth-child(1) > :nth-child(3)';

  it('create secret', () => {
    cy.get('textarea').type('hello world');
    cy.contains('Encrypt Message').click();

    cy.get(linkSelector).should(
      'contain',
      'http://localhost:3000/#/s/75c3383d-a0d9-4296-8ca8-026cc2272271',
    );

    cy.wait('@post').then(mockGetResponse);
    cy.get(linkSelector)
      .invoke('text')
      .then((url) => {
        cy.visit(url);
        cy.get('pre').contains('hello world');
      });
  });

  it('create secret with custom password', () => {
    const secret = 'this is a test';
    const password = 'My$3cr3tP4$$w0rd';
    cy.get('textarea').type(secret);
    cy.get(
      ':nth-child(3) > .MuiFormGroup-root > .MuiFormControlLabel-root > .MuiButtonBase-root > .MuiIconButton-label > .PrivateSwitchBase-input',
    ).click(); // Specify password
    cy.get('#password').type(password);
    cy.contains('Encrypt Message').click();

    cy.get(linkSelector).should(
      'contain',
      'http://localhost:3000/#/s/75c3383d-a0d9-4296-8ca8-026cc2272271',
    );

    cy.wait('@post').then(mockGetResponse);
    cy.get(linkSelector)
      .invoke('text')
      .then((text) => {
        cy.visit(text);
        cy.get('input').type(password);
        cy.get('button').click();
        cy.contains(secret);
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
    'http://localhost:3000/secret/75c3383d-a0d9-4296-8ca8-026cc2272271',
    {
      body: { message: body.message },
    },
  );
};
*/
