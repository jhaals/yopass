describe('Delete a Secret', () => {
  beforeEach(() => {
    cy.visit('/');
    cy.intercept('POST', 'http://localhost:3000/secret', {
      body: { message: '75c3383d-a0d9-4296-8ca8-026cc2272271' },
    }).as('post');
  });

  const linkSelector = '.MuiTableBody-root > :nth-child(1) > :nth-child(3)';

  it('should not be visible for one-time secrets', () => {
    cy.get('textarea[rows]').type('hello world');
    cy.contains('Encrypt Message').click();

    cy.wait('@post').then(mockGetOneTimeSecretResponse);

    cy.get(linkSelector)
      .invoke('text')
      .then((url) => {
        cy.visit(url);
        cy.get('button').should('not.have.text', 'Delete');
      });
  });

  it('that is time bound', () => {
    cy.get('textarea[rows]').type('hello world');
    cy.get('#enable-onetime').click();
    cy.contains('Encrypt Message').click();

    cy.wait('@post').then(mockGetTimeBoundSecretResponse);

    cy.get(linkSelector)
      .invoke('text')
      .then((url) => {
        cy.visit(url);
        cy.get('button')
          .contains('Delete')
          .click()
          .then(() => {
            cy.get('.MuiDialog-container button')
              .contains('Delete')
              .click()
              .then(() => {
                cy.get('div[role=alert]').contains(
                  'The secret is removed from the server!',
                );
              });
          });
      });
  });
});

// Take encrypted message from POST request and mock GET request with message.
const mockGetOneTimeSecretResponse = (intercept) => {
  const body = JSON.parse(intercept.request.body);
  expect(body.expiration).to.equal(3600);
  expect(body.one_time).to.equal(true);
  cy.intercept(
    'GET',
    'http://localhost:3000/secret/75c3383d-a0d9-4296-8ca8-026cc2272271',
    {
      body: { message: body.message, one_time: true },
    },
  );
};
const mockGetTimeBoundSecretResponse = (intercept) => {
  const body = JSON.parse(intercept.request.body);
  expect(body.expiration).to.equal(3600);
  expect(body.one_time).to.equal(false);
  cy.intercept(
    'GET',
    'http://localhost:3000/secret/75c3383d-a0d9-4296-8ca8-026cc2272271',
    {
      body: { message: body.message, one_time: false },
    },
  );
  cy.intercept(
    'DELETE',
    'http://localhost:3000/secret/75c3383d-a0d9-4296-8ca8-026cc2272271',
    { statusCode: 204 },
  );
};
