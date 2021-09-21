describe('Sign-In Button', () => {
  it('should enable', () => {
    cy.visit('http://localhost:3000/#/');
    cy.contains('button', 'Sign-In').should('be.enabled');
  });
});

describe('Blank Page Description', () => {
  it('should display', () => {
    cy.visit('http://localhost:3000/#/');
    cy.get('[data-test-id="headerDescription"]').should('have.text', 'Share Secrets Securely');
  });
});

describe('Header Description', () => {
  it('should display', () => {
    cy.visit('http://localhost:3000/#/');
    cy.get('[data-test-id="blankPageDescription"]').should(
      'have.text',
      'This page intentionally left blank.',
    );
  });
});

describe('Correct Header Icon', () => {
  it('Successfully Loads', () => {
    cy.visit('http://localhost:3000/#/');
    cy.get('[data-test-id="headerIconImage"]').should('be.visible');
  });
});

describe('Sign-In User', () => {
  it('should enable', () => {
    cy.visit('http://localhost:3000/#/');
    cy.contains('button', 'Sign-In').should('be.enabled');
    cy.get('[data-test-id="userButton"]').click();

    cy.get('#LoginFormToggleButton').click();
    cy.get('#Email').type(Cypress.env('ONETIME_TEST_USER_EMAIL'))
    cy.get('#Password').type(Cypress.env('ONETIME_TEST_USER_PASSWORD'))
    cy.get('#LoginFormActionButton').click();

    cy.get('[class=e-title-md]').should('have.text', 'Informasjonskapsler ikke funnet');
    cy.get('[class=e-text-description]').should('have.text', 'Vennligst prøv på nytt. Sørg for at informasjonskapsler (Cookies) ikke er blokkert i nettleseren og at du benytter en oppdatert nettleser.')
  });
});
