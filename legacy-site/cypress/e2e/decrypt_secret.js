describe('Decrypt Secret', () => {
  it('Fetch secret after a key is entered', () => {
    const secretID = 'a0eb3120-df7a-46b4-8820-8b7153855e57';
    const secondID = 'ce4a84c3-f7a9-430b-8ba5-71e021b58ae4';

    cy.visit('/#/s/' + secretID);
    cy.get('input').type('my-secret-password');

    mockSecretResponse(secretID);
    cy.contains('Decrypt secret').click();
    cy.wait('@get-' + secretID);

    // it should not use the same decrypt key as before'
    cy.visit('/#/s/' + secondID).then(() => {
      cy.get('input').should('have.value', '');
    });
  });
});

// Take encrypted message from POST request and mock GET request with message.
const mockSecretResponse = (uuid) => {
  cy.intercept('GET', 'http://localhost:3000/secret/' + uuid, {
    body: { message: uuid },
  }).as('get-' + uuid);
};
