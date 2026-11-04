import { mount } from 'svelte';
import '@fontsource/jersey-10/latin-400.css';
import '@fontsource/jersey-20/latin-400.css';
import './app.css';
import App from './App.svelte';

mount(App, { target: document.getElementById('app')! });
