'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function SetupCookiesPage() {
  const router = useRouter()

  useEffect(() => {
    checkAuthAndRedirect()
  }, [])

  async function checkAuthAndRedirect() {
    try {
      const res = await fetch('/api/auth/status')
      const data = await res.json()
      
      if (!data.isAuthenticated)
      {
        router.push('/login')
        return
      }

      router.push('/')
    }
    catch (err) {
      console.error('Failed to check auth:', err)
      router.push('/login')
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-gray-800 rounded-lg shadow-2xl p-8">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-500 bg-opacity-20 rounded-full mb-4">
            <svg className="w-8 h-8 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">
            YouTube OAuth Connected
          </h2>
          <p className="text-gray-400">
            Redirecting to dashboard...
          </p>
        </div>
      </div>
    </div>
  )
}
