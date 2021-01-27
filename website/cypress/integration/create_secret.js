describe('Create Secret', () => {
  beforeEach(() => {
    cy.visit('/');
    cy.intercept('POST', 'http://localhost:3000/secret', {
      body: { message: '75c3383d-a0d9-4296-8ca8-026cc2272271' },
    }).as('post');
  });

  it.only('create secret', () => {
    cy.get('textarea').type('hello world');
    cy.contains('Encrypt Message').click();
    console.log('fopo');
    console.log(cy.get('input').first());
    console.log('fopo');
    cy.get('input[id="copyField_One-click link"]').should(
      'contain.value',
      'http://localhost:3000/#/s/75c3383d-a0d9-4296-8ca8-026cc2272271',
    );

    cy.wait('@post').then(mockGetResponse);
    cy.get('input[id="copyField_One-click link"]')
      .invoke('val')
      .then((text) => {
        cy.visit(text);
        cy.contains('hello world');
      });
  });

  it('create secret with custom password', () => {
    const secret = 'this is a test';
    const password = 'My$3cr3tP4$$w0rd';
    cy.get('textarea').type(secret);
    cy.get(':nth-child(2) > .form-check-input').click(); // Specify password
    cy.get('#password').type(password);
    cy.contains('Encrypt Message').click();
    cy.get('input[id="copyField_Short Link"]').should(
      'contain.value',
      'http://localhost:3000/#/c/75c3383d-a0d9-4296-8ca8-026cc2272271',
    );

    cy.wait('@post').then(mockGetResponse);
    cy.get('input[id="copyField_Short Link"]')
      .invoke('val')
      .then((text) => {
        cy.visit(text);
        cy.get('input').type(password);
        cy.get('.btn').click();
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
