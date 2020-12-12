import { HashRouter as Router } from 'react-router-dom';
import { Container } from '@material-ui/core';
import { ThemeProvider } from '@material-ui/core/styles';

import './App.scss';

import { Header } from './shared/Header';
import { Routes } from './Routes';
import { Features } from './shared/Features';
import { Attribution } from './shared/Attribution';
import { theme } from './theme';

const App = () => {
  return (
    <ThemeProvider theme={theme}>
      <Router>
        <Header />
        <Container maxWidth={"lg"}>
          <Routes />
          <Features />
          <Attribution />
        </Container>
      </Router>
    </ThemeProvider>
  );
};

export default App;
