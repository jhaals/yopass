import * as React from 'react';
import Head from 'next/head';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { CacheProvider, EmotionCache } from '@emotion/react';
import theme from '../src/theme';
import createEmotionCache from '../src/createEmotionCache';
import type { AppProps /*, AppContext */ } from 'next/app';
import { appWithTranslation } from 'next-i18next';
import Header from '../src/components/Header';
import { Container } from '@mui/material';
import { Attribution } from '../src/components/Attribution';
import { Features } from '../src/components/Features';
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';

// Client-side cache, shared for the whole session of the user in the browser.
const clientSideEmotionCache = createEmotionCache();

interface MyAppProps extends AppProps {
  emotionCache?: EmotionCache;
}

function MyApp(props: MyAppProps) {
  const { Component, pageProps, emotionCache = clientSideEmotionCache } = props;

  return (
    <CacheProvider value={emotionCache}>
      <Head>
        <title>Yopass: Share Secrets Securely</title>
        <meta name="viewport" content="initial-scale=1, width=device-width" />
        <meta
          name="description"
          content="Secure secret sharing, end to end encrypted in browser"
        />
      </Head>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Header />
        <Container maxWidth={'lg'}>
          <Component {...pageProps} />
          <Features />
          <Attribution />
        </Container>
      </ThemeProvider>
    </CacheProvider>
  );
}

export default appWithTranslation(MyApp);
