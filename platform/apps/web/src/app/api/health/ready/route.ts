import { checkDatabaseReadiness } from '@resume/infrastructure/postgres';
import { NextResponse } from 'next/server';

import { getApplicationPool } from '@/server/runtime';

export async function GET() {
  try {
    const ready = await checkDatabaseReadiness(getApplicationPool());
    return NextResponse.json(
      { status: ready ? ('ready' as const) : ('unavailable' as const) },
      { status: ready ? 200 : 503 },
    );
  } catch {
    return NextResponse.json({ status: 'misconfigured' as const }, { status: 503 });
  }
}
