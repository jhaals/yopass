describe('Sign-In Button', () => {
  it('should enable', () => {
    cy.visit('http://localhost:3000/#/');
    cy.contains('button', 'Sign-In').should('be.enabled');
  });
});

describe('Blank Page Description', () => {
  it('should display', () => {
    cy.visit('http://localhost:3000/#/');
    cy.get('#headerDescription').should('have.text', 'Share Secrets Securely');
  });
});

describe('Header Description', () => {
  it('should display', () => {
    cy.visit('http://localhost:3000/#/');
    cy.get('#blankPageDescription').should(
      'have.text',
      'This page intentionally left blank.',
    );
  });
});

describe('Correct Header Icon', () => {
  it('Successfully Loads', () => {
    cy.visit('http://localhost:3000/#/');
    cy.get('#headerIconImage').should('be.visible');
  });
});
