import * as React from 'react';
import { HashRouter as Router } from 'react-router-dom';
import { Container } from 'reactstrap';

import './App.scss';

import { Header } from './Header';
import { Routes } from './Routes';
import { Features } from './Features';
import { Attribution } from './Attribution';

const App: React.FC = () => {
  return (
    <Router>
      <Header />
      <Container className="margin">
        <Routes />
      </Container>
      <Features />
      <Attribution />
    </Router>
  );
};

export default App;
