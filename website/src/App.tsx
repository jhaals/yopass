import * as React from 'react';
import { HashRouter as Router } from 'react-router-dom';
import { Container } from 'reactstrap';

import './App.scss';

import { Header } from './shared/Header';
import { Routes } from './Routes';
import { Features } from './shared/Features';
import { Attribution } from './shared/Attribution';

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
