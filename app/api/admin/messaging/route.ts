import { NextResponse } from 'next/server';
import { RoomServiceClient, DataPacket_Kind } from 'livekit-server-sdk';
import { verifyRole } from '@/lib/auth/verifyRole';

const wsUrl = process.env.LIVEKIT_URL!;
const apiUrl = wsUrl.replace(/^wss?/, 'https');
const client = new RoomServiceClient(apiUrl, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);

// Message types
type MessageType = 'text' | 'file' | 'ack';

interface Message {
  id: string;
  type: MessageType;
  senderId: string;
  receiverId: string;
  content: string;
  timestamp: number;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  messageId?: string;
}

export async function POST(req: Request) {
  try {
    const { roomName, action, senderId, receiverId, content, fileUrl, messageId } = await req.json();
    const roleCheck = await verifyRole(req as any, ['admin', 'host', 'co-host', 'participant']);
    if (roleCheck) return roleCheck;

    switch (action) {
      case 'sendMessage':
        const messageId = `msg_${Date.now()}`;
        const message = {
          id: messageId,
          senderId,
          receiverId,
          content,
          type: 'text',
          timestamp: Date.now()
        };

        // Send using LiveKit's data channel
        await client.sendData(
          roomName,
          Buffer.from(JSON.stringify({
            type: 'direct_message',
            message
          })),
          DataPacket_Kind.RELIABLE,
          [receiverId]
        );

        // Check if receiver is in room and update their metadata immediately
        const participants = await client.listParticipants(roomName);
        const receiver = participants.find(p => p.identity === receiverId);
        let deliveryStatus = 'pending';
        let reason = undefined;

        if (receiver) {
          try {
            const metadata = receiver.metadata ? JSON.parse(receiver.metadata) : {};
            const receivedMessages = metadata.receivedMessages || [];
            receivedMessages.push(messageId);

            await client.updateParticipant(
              roomName,
              receiverId,
              JSON.stringify({
                ...metadata,
                receivedMessages
              })
            );
            deliveryStatus = 'delivered';
          } catch (error) {
            console.error('Error updating receiver metadata:', error);
            deliveryStatus = 'pending';
          }
        } else {
          deliveryStatus = 'undelivered';
          reason = 'participant_not_in_room';
        }

        return NextResponse.json({
          success: true,
          message,
          delivery: {
            status: deliveryStatus,
            timestamp: Date.now(),
            reason
          }
        });

      case 'sendFile':
        const fileMessage = {
          id: `msg_${Date.now()}`,
          senderId,
          receiverId,
          content,
          type: 'file',
          timestamp: Date.now(),
          fileUrl
        };

        // Send file message through LiveKit data channel
        await client.sendData(
          roomName,
          Buffer.from(JSON.stringify({
            type: 'direct_message',
            message: fileMessage
          })),
          DataPacket_Kind.RELIABLE,
          [receiverId]
        );

        return NextResponse.json({ success: true, message: fileMessage });

      case 'acknowledgeMessage':
        const { messageId: ackMessageId } = await req.json();
        if (!ackMessageId) {
          return NextResponse.json({ error: 'No messageId provided' }, { status: 400 });
        }

        // Update receiver's metadata with received message
        const participant = (await client.listParticipants(roomName))
          .find(p => p.identity === receiverId);

        if (participant) {
          const metadata = participant.metadata ? JSON.parse(participant.metadata) : {};
          const receivedMessages = metadata.receivedMessages || [];
          receivedMessages.push(ackMessageId);

          await client.updateParticipant(
            roomName,
            receiverId,
            JSON.stringify({
              ...metadata,
              receivedMessages
            })
          );

          // Send acknowledgment through data channel
          await client.sendData(
            roomName,
            Buffer.from(JSON.stringify({
              type: 'message_ack',
              messageId: ackMessageId,
              receiverId,
              timestamp: Date.now()
            })),
            DataPacket_Kind.RELIABLE,
            [senderId]  // Send ack to original sender
          );
        }

        return NextResponse.json({ success: true });

      case 'getMessages':
        // In a production environment, I would:
        // 1. Query your database for message history
        // 2. Return paginated results
        return NextResponse.json({ 
          success: true, 
          messages: [] // Would be fetched from database in production
        });

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (err: any) {
    console.error('Messaging error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
} 