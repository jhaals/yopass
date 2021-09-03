describe('Correct Home Page', () => {
  it('Successfully Loads', () => {
    cy.visit('http://localhost:3000/#/');
    cy.contains('button', 'Sign-In').should('be.enabled');
  });
});

describe('Correct Blank Page Description', () => {
  it('Successfully Loads', () => {
    cy.visit('http://localhost:3000/#/');
    cy.get('#headerDescription').should('have.text', 'Share Secrets Securely');
  });
});

describe('Correct Header Description', () => {
  it('Successfully Loads', () => {
    cy.visit('http://localhost:3000/#/');
    cy.get('#blankPageDescription').should(
      'have.text',
      'This page intentionally left blank.',
    );
  });
});
