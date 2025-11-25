'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export default function LoginPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    checkAuth()
    
    const errorParam = searchParams.get('error')
    
    if (errorParam)
    {
      setError('Authentication failed. Please try again.')
    }
  }, [searchParams])

  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/status')
      const data = await res.json()
      
      if (data.isAuthenticated)
      {
        router.push('/')
      }
    }
    catch (err) {
      console.error('Failed to check auth status:', err)
    }
  }

  async function handleGoogleLogin() {
    setLoading(true)
    setError('')
    
    try {
      const res = await fetch('/api/auth/google/start')
      const data = await res.json()
      
      if (!res.ok)
      {
        throw new Error(data.error || 'Failed to start OAuth flow')
      }
      
      window.location.href = data.authUrl
    }
    catch (err: any) {
      setError(err.message || 'Failed to initiate Google login')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-gray-800 rounded-lg shadow-xl p-8">
        <h1 className="text-3xl font-bold mb-2">YT Shortsmith</h1>
        <p className="text-gray-400 mb-8">Sign in with Google to continue</p>
        
        {error && (
          <div className="mb-6 p-4 bg-red-900/50 border border-red-700 rounded-lg">
            <p className="text-red-200 text-sm">{error}</p>
          </div>
        )}
        
        <button
          onClick={handleGoogleLogin}
          disabled={loading}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-semibold py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          {loading ? (
            'Redirecting...'
          ) : (
            <>
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </>
          )}
        </button>
        
        <div className="mt-8 pt-6 border-t border-gray-700">
          <h2 className="font-semibold mb-2">What happens next?</h2>
          <ul className="text-sm text-gray-400 space-y-2">
            <li className="flex items-start gap-2">
              <span className="text-blue-400 mt-0.5">1.</span>
              <span>Sign in with your Google account</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-blue-400 mt-0.5">2.</span>
              <span>Start creating short clips from YouTube videos</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
