import '@fontsource-variable/inter'
import '@fontsource-variable/source-serif-4'
import '@fontsource-variable/source-serif-4/wght-italic.css'
import '@fontsource-variable/jetbrains-mono'
import 'hack-font/build/web/hack.css'
import 'katex/dist/katex.min.css'
import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { DebugApp } from './debug/DebugApp'

// The debugger window loads this same bundle at #debug.
const isDebugger = window.location.hash.startsWith('#debug')

createRoot(document.getElementById('root')!).render(<StrictMode>{isDebugger ? <DebugApp /> : <App />}</StrictMode>)
