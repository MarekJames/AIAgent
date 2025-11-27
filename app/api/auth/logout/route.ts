import { NextResponse } from 'next/server'
import { getSession } from '@/src/lib/session'

export async function POST() {
  try {
    const session = await getSession()
    session.destroy()
    
    return NextResponse.json({ success: true })
  }
  catch (error) {
    return NextResponse.json(
      { error: 'Failed to logout' },
      { status: 500 }
    )
  }
}
