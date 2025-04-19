mdc.ripple.MDCRipple.attachTo(document.querySelector('.mdc-button'));

// Default configuration - Change these if you have a different STUN or TURN server.
const configuration = {
  iceServers: [
    {
      urls: [
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
  ],
  iceCandidatePoolSize: 10,
};

let peerConnection = null;
let localStream = null;
let remoteStream = null;
let roomDialog = null;
let roomId = null;

/**
 * Collects ICE candidates and exchanges them via Firestore.
 * @param {firebase.firestore.DocumentReference} roomRef
 * @param {RTCPeerConnection} peerConnection
 * @param {string} localName     - e.g. "callerCandidates" or "calleeCandidates"
 * @param {string} remoteName    - the opposite collection name
 */
async function collectIceCandidates(roomRef, peerConnection, localName, remoteName) {
  const candidatesCollection = roomRef.collection(localName);

  // Send local ICE candidates to Firestore
  peerConnection.addEventListener('icecandidate', event => {
    if (event.candidate) {
      const json = event.candidate.toJSON();
      candidatesCollection.add(json);
    }
  });

  // Listen for remote ICE candidates from Firestore
  roomRef.collection(remoteName).onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type === 'added') {
        const candidate = new RTCIceCandidate(change.doc.data());
        peerConnection.addIceCandidate(candidate);
      }
    });
  });
}

function init() {
  document.querySelector('#cameraBtn').addEventListener('click', openUserMedia);
  document.querySelector('#hangupBtn').addEventListener('click', hangUp);
  document.querySelector('#createBtn').addEventListener('click', createRoom);
  document.querySelector('#joinBtn').addEventListener('click', joinRoom);
  roomDialog = new mdc.dialog.MDCDialog(document.querySelector('#room-dialog'));
}

async function createRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;
  const db = firebase.firestore();

  console.log('Create PeerConnection with configuration: ', configuration);
  peerConnection = new RTCPeerConnection(configuration);
  registerPeerConnectionListeners();

  // Add local tracks
  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  // Create offer
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  // Save offer to Firestore
  const roomWithOffer = {
    offer: {
      type: offer.type,
      sdp: offer.sdp
    }
  };
  const roomRef = await db.collection('rooms').add(roomWithOffer);
  roomId = roomRef.id;
  document.querySelector('#currentRoom').innerText =
    `Current room is ${roomId} - You are the caller!`;

  // Exchange ICE candidates
  await collectIceCandidates(roomRef, peerConnection, 'callerCandidates', 'calleeCandidates');

  // Listen for remote answer
  roomRef.onSnapshot(async snapshot => {
    const data = snapshot.data();
    if (!peerConnection.currentRemoteDescription && data.answer) {
      console.log('Received answer:', data.answer);
      const answerDesc = new RTCSessionDescription(data.answer);
      await peerConnection.setRemoteDescription(answerDesc);
    }
  });

  // Remote track handler
  peerConnection.addEventListener('track', event => {
    event.streams[0].getTracks().forEach(track => {
      remoteStream.addTrack(track);
    });
  });
}

function joinRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;

  document.querySelector('#confirmJoinBtn')
    .addEventListener('click', async () => {
      roomId = document.querySelector('#room-id').value;
      document.querySelector('#currentRoom').innerText =
        `Current room is ${roomId} - You are the callee!`;
      await joinRoomById(roomId);
    }, { once: true });

  roomDialog.open();
}

async function joinRoomById(roomId) {
  const db = firebase.firestore();
  const roomRef = db.collection('rooms').doc(roomId);
  const roomSnapshot = await roomRef.get();

  if (!roomSnapshot.exists) {
    console.error('Room does not exist!');
    return;
  }

  console.log('Creating PeerConnection for join:', configuration);
  peerConnection = new RTCPeerConnection(configuration);
  registerPeerConnectionListeners();

  // Add local tracks
  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  // Exchange ICE candidates
  await collectIceCandidates(roomRef, peerConnection, 'calleeCandidates', 'callerCandidates');

  // Remote track handler
  peerConnection.addEventListener('track', event => {
    event.streams[0].getTracks().forEach(track => {
      remoteStream.addTrack(track);
    });
  });

  // Create and send SDP answer
  const offer = roomSnapshot.data().offer;
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  const roomWithAnswer = {
    answer: {
      type: answer.type,
      sdp: answer.sdp
    }
  };
  await roomRef.update(roomWithAnswer);
}

async function openUserMedia() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  document.querySelector('#localVideo').srcObject = stream;
  localStream = stream;

  remoteStream = new MediaStream();
  document.querySelector('#remoteVideo').srcObject = remoteStream;

  document.querySelector('#cameraBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = false;
  document.querySelector('#createBtn').disabled = false;
  document.querySelector('#hangupBtn').disabled = false;
}

async function hangUp() {
  localStream.getTracks().forEach(track => track.stop());
  if (remoteStream) remoteStream.getTracks().forEach(track => track.stop());
  if (peerConnection) peerConnection.close();

  document.querySelector('#localVideo').srcObject = null;
  document.querySelector('#remoteVideo').srcObject = null;
  document.querySelector('#cameraBtn').disabled = false;
  document.querySelector('#joinBtn').disabled = true;
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#hangupBtn').disabled = true;
  document.querySelector('#currentRoom').innerText = '';

  if (roomId) {
    const db = firebase.firestore();
    const roomRef = db.collection('rooms').doc(roomId);

    const calleeCandidates = await roomRef.collection('calleeCandidates').get();
    calleeCandidates.forEach(async doc => await doc.ref.delete());

    const callerCandidates = await roomRef.collection('callerCandidates').get();
    callerCandidates.forEach(async doc => await doc.ref.delete());

    await roomRef.delete();
  }

  document.location.reload(true);
}

function registerPeerConnectionListeners() {
  peerConnection.addEventListener('icegatheringstatechange', () => {
    console.log(`ICE gathering state changed: ${peerConnection.iceGatheringState}`);
  });
  peerConnection.addEventListener('connectionstatechange', () => {
    console.log(`Connection state change: ${peerConnection.connectionState}`);
  });
  peerConnection.addEventListener('signalingstatechange', () => {
    console.log(`Signaling state change: ${peerConnection.signalingState}`);
  });
  peerConnection.addEventListener('iceconnectionstatechange', () => {
    console.log(`ICE connection state change: ${peerConnection.iceConnectionState}`);
  });
}

init();
