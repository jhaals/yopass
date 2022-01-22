describe('Decrypt Secret', () => {
  it('Fetch secret after a key is entered', async () => {
    const secretID = 'a0eb3120-df7a-46b4-8820-8b7153855e57';

    cy.visit('/s#' + secretID);
    cy.get('input').type('my-secret-password');

    mockSecretResponse(secretID);
    cy.get('button').click();
    cy.wait('@get-' + secretID);
  });
});

// Take encrypted message from POST request and mock GET request with message.
const mockSecretResponse = (uuid) => {
  cy.intercept('GET', 'http://localhost:3000/api/secret/' + uuid, {
    body: { message: uuid },
  }).as('get-' + uuid);
};
