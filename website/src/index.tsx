import * as React from 'react';
import { Suspense } from 'react';
import * as ReactDOM from 'react-dom';
import App from './App';
import "./i18n";
import registerServiceWorker from './registerServiceWorker';

ReactDOM.render(
    <Suspense fallback={<div>Loading...</div>}>
        <App />
    </Suspense>,
document.getElementById('root') as HTMLElement
);

registerServiceWorker();
