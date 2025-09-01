describe('Create Secret', () => {
  beforeEach(() => {
    cy.visit('/');
    cy.intercept('POST', 'http://localhost:3000/secret', {
      headers: { 'content-type': 'application/json' },
      body: { message: '75c3383d-a0d9-4296-8ca8-026cc2272271' },
    }).as('post');
  });

  const linkSelector = '.MuiTableBody-root > :nth-child(1) > :nth-child(3)';

  it('create secret', () => {
    cy.get('textarea[rows]').type('hello world');
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
        cy.get('[data-test-id="preformatted-text-secret"]').contains(
          'hello world',
        );
      });
  });

  it('create secret with custom password', () => {
    const secret = 'this is a test';
    const password = 'My$3cr3tP4$$w0rd';
    cy.get('textarea[rows]').type(secret);
    cy.get(
      '.MuiFormGroup-root > .MuiFormControlLabel-root > .MuiCheckbox-root > .PrivateSwitchBase-input',
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
        cy.contains('Decrypt secret').click();
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
