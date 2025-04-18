import { NextResponse } from 'next/server';
import { RoomServiceClient } from 'livekit-server-sdk';
import { verifyRole } from '@/lib/auth/verifyRole';

const wsUrl = process.env.LIVEKIT_URL!;
const apiUrl = wsUrl.replace(/^wss?/, 'https');
const client = new RoomServiceClient(apiUrl, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);

export async function POST(req: Request) {
  try {
    const { roomName, messageId, receiverId } = await req.json();
    const roleCheck = await verifyRole(req as any, ['admin', 'host', 'co-host', 'participant']);
    if (roleCheck) return roleCheck;

    // Check if receiver is in the room
    const participants = await client.listParticipants(roomName);
    const receiver = participants.find(p => p.identity === receiverId);

    if (!receiver) {
      return NextResponse.json({ 
        success: true, 
        status: 'undelivered',
        reason: 'participant_not_in_room'
      });
    }

    // Get participant's metadata to check received messages
    const metadata = receiver.metadata ? JSON.parse(receiver.metadata) : {};
    const receivedMessages = metadata.receivedMessages || [];

    const isDelivered = receivedMessages.includes(messageId);

    return NextResponse.json({
      success: true,
      status: isDelivered ? 'delivered' : 'pending',
      timestamp: Date.now()
    });

  } catch (err: any) {
    console.error('Message status check error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
} 