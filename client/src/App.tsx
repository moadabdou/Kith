import { useEffect, useState } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

type PingResponse = { service: string; status: string }

function App() {
  const [apiStatus, setApiStatus] = useState('checking api…')

  useEffect(() => {
    fetch(`${API_BASE}/ping`)
      .then((res) => res.json() as Promise<PingResponse>)
      .then((body) => setApiStatus(`api: ${body.status}`))
      .catch(() => setApiStatus('api unreachable'))
  }, [])

  return (
    <main>
      <h1>Kith</h1>
      <p>{apiStatus}</p>
    </main>
  )
}

export default App
