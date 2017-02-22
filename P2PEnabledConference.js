/* global __filename */

import {getLogger} from "jitsi-meet-logger";
const logger = getLogger(__filename);
import * as JingleSessionState from "./modules/xmpp/JingleSessionState";
import JitsiConference from "./JitsiConference";
import * as JitsiConferenceEvents from "./JitsiConferenceEvents";
import * as RTCEvents from "./service/RTC/RTCEvents";
import * as XMPPEvents from "./service/xmpp/XMPPEvents";

/**
 * A peer to peer enabled conference that will try to use direct connection when
 * available in case there are only 2 participants in the room. The JVB
 * connection will be kept alive and it will be reused if the 3rd participant
 * joins.
 *
 * When the conference is being switched from one mode to another the local
 * tracks are detached from inactive session (through JingleSessionPC). It means
 * that locally those tracks are removed from the underlying PeerConnection, but
 * are still signalled to the remote participants. No data is being sent for
 * those tracks.
 * As for the remote tracks those are replaced by generating fake "remote track
 * added/removed" events.
 */
export default class P2PEnabledConference extends JitsiConference {
    /**
     * Creates new <tt>P2PEnabledConference</tt>.
     * @param options see description in {@link JitsiConference} constructor.
     * @param {number} [options.config.backToP2PDelay=5] a delay given in
     * seconds, before the conference switches back to P2P after the 3rd
     * participant has left.
     */
    constructor(options) {
        // Call super
        super(options);
        // Original this.eventEmitter.emit method, stored to skip the event
        // filtering logic
        this._originalEmit = this.eventEmitter.emit.bind(this.eventEmitter);
        // Intercepts original event emitter calls to filter out some of
        // the conference events
        this.eventEmitter.emit = this._emitIntercept.bind(this);
        /**
         * Stores reference to deferred start P2P task. It's created when 3rd
         * participant leaves the room in order to avoid ping pong effect (it
         * could be just a page reload).
         * @type {number|null}
         */
        this.deferredStartP2P = null;

        const delay = parseInt(options.config.backToP2PDelay);
        /**
         * A delay given in seconds, before the conference switches back to P2P
         * after the 3rd participant has left.
         * @type {number}
         */
        this.backToP2PDelay = isNaN(delay) ? 5 : delay;
        logger.info("backToP2PDelay: " + this.backToP2PDelay);

        /**
         * If set to <tt>true</tt> it means the P2P ICE is no longer connected.
         * When <tt>false</tt> it means that P2P ICE (media) connection is up
         * and running.
         * @type {boolean}
         */
        this.isP2PConnectionInterrupted = false;
        /**
         * Flag set to <tt>true</tt> when P2P session has been established
         * (ICE has been connected).
         * @type {boolean}
         */
        this.p2pEstablished = false;
        /**
         * Fake <tt>ChatRoom</tt> passed to {@link peerToPeerSession}.
         * @type {FakeChatRoomLayer}
         */
        this.peerToPeerFakeRoom = null;
        /**
         * A JingleSession for the direct peer to peer connection.
         * @type {JingleSessionPC}
         */
        this.peerToPeerSession = null;
    }

    /**
     * Accept incoming P2P Jingle call.
     * @param {JingleSessionPC} jingleSession the session instance
     * @param {jQuery} jingleOffer a jQuery selector pointing to 'jingle' IQ
     * element.
     * @private
     */
    _acceptP2PIncomingCall (jingleSession, jingleOffer) {

        jingleSession.setSSRCOwnerJid(this.room.myroomjid);

        // Accept the offer
        this.peerToPeerSession = jingleSession;
        // FIXME .P2P should be set initially in strophe.jingle.js
        this.peerToPeerSession.isP2P = true;
        this.peerToPeerFakeRoom = this._createFakeRoom(false);
        this.peerToPeerSession.initialize(
            false /* initiator */, this.peerToPeerFakeRoom, this.rtc);

        const localTracks = this.getLocalTracks();

        logger.debug("Adding " + localTracks + " to P2P...");
        this.peerToPeerSession.addLocalTracks(localTracks).then(
            () => {
                logger.debug("Add " + localTracks + " to P2P done!");
                this.peerToPeerSession.acceptOffer(
                    jingleOffer,
                    () => {
                        logger.debug("Got RESULT for P2P 'session-accept'");
                    },
                    (error) => {
                        logger.error(
                            "Failed to accept incoming P2P Jingle session",
                            error);
                    }
                );
            },
            (error) => {
                logger.error(
                    "Failed to add " + localTracks + " to the P2P connection",
                    error);
            });
    }

    /**
     * @inheritDoc
     * @override
     */
    _addLocalTrackAsUnmute (track) {
        const all = [super._addLocalTrackAsUnmute(track)];
        if (this.peerToPeerSession) {
            all.push(this.peerToPeerSession.addTrackAsUnmute(track));
        }
        return Promise.all(all);
    }

    /**
     * Attaches local tracks back to the JVB connection.
     * @private
     */
    _addLocalTracksToJVB() {
        const localTracks = this.getLocalTracks();

        logger.info("Attaching " + localTracks + " to JVB");
        this.jingleSession.attachLocalTracks(localTracks).then(
            () => {
                logger.info("Attach " + localTracks + " to JVB success!");
            },
            (error) => {
                logger.error(
                    "Attach " + localTracks + " to JVB failed!", error);
            });
    }

    /**
     * Adds remote tracks to the conference associated with the P2P session.
     * @private
     */
    _addP2PRemoteTracks () {
        this._addRemoteTracks("P2P", this.peerToPeerSession);
    }

    /**
     * Adds remote tracks to the conference associated with the JVB session.
     * @private
     */
    _addRemoteJVBTracks () {
        this._addRemoteTracks("JVB", this.jingleSession);
    }

    /**
     * Generates fake "remote track added" events for given Jingle session.
     * @param {string} logName the session's nickname which will appear in log
     * messages.
     * @param {JingleSessionPC} jingleSession the session for which remote
     * tracks will be added.
     * @private
     */
    _addRemoteTracks (logName, jingleSession) {
        if (!jingleSession) {
            logger.info(
                "Not adding remote " + logName + " tracks - no session yet");
            return;
        }
        const remoteTracks = jingleSession.peerconnection.getRemoteTracks();
        remoteTracks.forEach(
            (track) => {
                logger.info("Adding remote " + logName + " track: " + track);
                this.rtc.eventEmitter.emit(
                    RTCEvents.REMOTE_TRACK_ADDED, track);
            });
    }

    /**
     * Creates fake {@link ChatRoom} which is to be used by the P2P Jingle
     * Session.
     * @param {boolean} isInitiator indicates whether the room is to be create
     * for 'initiator' or 'responder'
     * @return {FakeChatRoomLayer}
     * @private
     */
    _createFakeRoom(isInitiator) {
        return new FakeChatRoomLayer(this, isInitiator);
    }

    /**
     * @inheritDoc
     * @override
     */
    _doReplaceTrack (oldTrack, newTrack) {
        const all = [super._doReplaceTrack(oldTrack, newTrack)];
        if (this.peerToPeerSession) {
            all.push(this.peerToPeerSession.replaceTrack(oldTrack, newTrack));
        }
        return Promise.all(all);
    }

    /**
     * Intercepts events emitted by parent <tt>JitsiConference</tt>
     * @private
     */
    _emitIntercept(eventType) {
        const shouldBlock = this._shouldBlockEvent(eventType);
        switch (eventType) {
            // Log events which may be of interest for the P2P implementation
            case JitsiConferenceEvents.CONNECTION_INTERRUPTED:
            case JitsiConferenceEvents.CONNECTION_RESTORED:
            case JitsiConferenceEvents.P2P_STATUS:
                logger.debug(
                    "_emitIntercept: block? " + shouldBlock, arguments);
                break;
        }
        if (!shouldBlock)
            this._originalEmit.apply(this.eventEmitter, arguments);
    }

    /**
     * @inheritDoc
     * @override
     * @private
     */
    _ensureRemoteStatsRunning () {
        if (this.p2pEstablished) {
            // Use remote starts from the P2P connection
            this.statistics.startRemoteStats(
                this.peerToPeerSession.peerconnection);
        } else {
            // This will start remote stats for the JVB connection
            super._ensureRemoteStatsRunning();
        }
    }

    /**
     * Called when {@link JitsiConferenceEvents.CONNECTION_ESTABLISHED} event is
     * triggered for the P2P session. Switches the conference to use the P2P
     * connection.
     * @param {JingleSessionPC} jingleSession the session instance. It should be
     * always the P2P one, but still worth to verify for bug detection
     * @private
     */
    _onP2PConnectionEstablished (jingleSession) {
        if (this.peerToPeerSession !== jingleSession) {
            logger.error("CONNECTION_ESTABLISHED - not P2P session ?!");
            return;
        }
        // Update P2P status and emit events
        this._setNewP2PStatus(true);

        // Remove remote tracks
        this._removeRemoteJVBTracks();
        // Add remote tracks
        this._addP2PRemoteTracks();
        // Remove local tracks from JVB PC
        // But only if it has started
        if (this.jingleSession) {
            this._removeLocalTracksFromJVB();
        }

        // Start remote stats
        logger.info("Starting remote stats with p2p connection");
        this._ensureRemoteStatsRunning();
    }

    /**
     * Detaches local tracks from the JVB connection.
     * @private
     */
    _removeLocalTracksFromJVB() {
        const localTracks = this.getLocalTracks();
        logger.info("Detaching local tracks from JVB: " + localTracks);
        this.jingleSession.detachLocalTracks(localTracks)
            .then(() => {
                logger.info(
                    "Detach local tracks from JVB done!" + localTracks);
            }, (error) => {
                logger.info(
                    "Detach local tracks from JVB failed!" + localTracks,
                    error);
            });
    }

    /**
     * Removes from the conference remote tracks associated with the P2P
     * connection.
     * @private
     */
    _removeP2PRemoteTracks () {
        this._removeRemoteTracks("P2P", this.peerToPeerSession);
    }

    /**
     * Removes from the conference remote tracks associated with the JVB
     * connection.
     * @private
     */
    _removeRemoteJVBTracks () {
        this._removeRemoteTracks("JVB", this.jingleSession);
    }

    /**
     * Generates fake "remote track removed" events for given Jingle session.
     * @param {string} logName the session's nickname which will appear in log
     * messages.
     * @param {JingleSessionPC} jingleSession the session for which remote
     * tracks will be removed.
     * @private
     */
    _removeRemoteTracks (logName, jingleSession) {
        if (!jingleSession) {
            logger.info(
                "Not removing remote " + logName + " tracks - no session yet");
            return;
        }
        jingleSession.peerconnection.getRemoteTracks().forEach(
            (track) => {
                logger.info("Removing remote " + logName + " track: " + track);
                this.rtc.eventEmitter.emit(
                    RTCEvents.REMOTE_TRACK_REMOVED, track);
            });
    }

    /**
     * @inheritDoc
     * @override
     */
    _removeTrackAsMute (track) {
        const all = [super._removeTrackAsMute(track)];
        if (this.peerToPeerSession) {
            all.push(this.peerToPeerSession.removeTrackAsMute(track));
        }
        return Promise.all(all);
    }

    /**
     * Sets new P2P status and updates some events/states hijacked from
     * the <tt>JitsiConference</tt>.
     * @param {boolean} newStatus the new P2P status value, <tt>true</tt> means
     * that P2P is now in use, <tt>false</tt> means that the JVB connection is
     * now in use.
     * @private
     */
    _setNewP2PStatus (newStatus) {
        this.p2pEstablished = newStatus;
        if (newStatus) {
            logger.info("Peer to peer connection established!");
        } else {
            logger.info("Peer to peer connection closed!");
        }
        // Update P2P status
        this.eventEmitter.emit(
            JitsiConferenceEvents.P2P_STATUS, this, this.p2pEstablished);
        // Refresh connection interrupted/restored
        this._originalEmit(
            this.isConnectionInterrupted()
                ? JitsiConferenceEvents.CONNECTION_INTERRUPTED
                : JitsiConferenceEvents.CONNECTION_RESTORED);
    }

    /**
     * Checks whether or not given event coming from
     * the <tt>JitsiConference</tt> should be blocked or not.
     * @param {string} eventType the event type name
     * @return {boolean} <tt>true</tt> to block or <tt>false</tt> to let through
     * @private
     */
    _shouldBlockEvent (eventType) {
        switch (eventType) {
            case JitsiConferenceEvents.CONNECTION_INTERRUPTED:
            case JitsiConferenceEvents.CONNECTION_RESTORED:
                return this.p2pEstablished;
            default:
                return false;
        }
    }

    /**
     * Starts new P2P session.
     * @param {string} peerJid the JID of the remote participant
     * @private
     */
    _startPeer2PeerSession(peerJid) {
        if (this.deferredStartP2P) {
            // Make not that the task has been executed
            this.deferredStartP2P = null;
        }
        if (this.peerToPeerSession) {
            logger.error("P2P session already started!");
            return;
        }

        /*if (!peerJid) {
            const peers = this.getParticipants();
            const peerCount = peers.length;

            // Start peer to peer session
            if (peerCount > 0) {
                peerJid = peers[0].getJid();
            } else {
                logger.error("No JID to start the P2P session with !");
                return;
            }
        }*/

        this.peerToPeerSession
            = this.xmpp.connection.jingle.newJingleSession(
                this.room.myroomjid, peerJid);
        this.peerToPeerSession.setSSRCOwnerJid(this.room.myroomjid);
        this.peerToPeerFakeRoom = this._createFakeRoom(true);

        logger.info(
            "Created new P2P JingleSession", this.room.myroomjid, peerJid);

        this.peerToPeerSession.initialize(
            true /* initiator */, this.peerToPeerFakeRoom, this.rtc);

        // NOTE one may consider to start P2P with the local tracks detached,
        // but no data will be sent until ICE succeeds anyway. And we switch
        // immediately once the P2P ICE connects.
        const localTracks = this.getLocalTracks();

        logger.info("Adding " + localTracks + " to P2P...");
        this.peerToPeerSession.addLocalTracks(localTracks).then(
            () => {
                logger.info("Added " + localTracks + " to P2P");
                logger.info("About to send P2P 'session-initiate'...");
                this.peerToPeerSession.invite();
            },
            (error) => {
                logger.error("Failed to add " + localTracks + " to P2P", error);
            });
    }

    /**
     * Method when called will decide whether it's the time to start or stop the
     * P2P session.
     * @param {boolean} userLeftEvent if <tt>true</tt> it means that the call
     * originates from the user left event.
     * @private
     */
    _startStopP2PSession (userLeftEvent) {
        if (this.options.config.disableAutoP2P) {
            logger.info("Auto P2P disabled");
            return;
        }
        const peers = this.getParticipants();
        const peerCount = peers.length;
        const isModerator = this.isModerator();
        // FIXME 1 peer and it must *support* P2P switching
        const shouldBeInP2P = peerCount === 1;

        logger.debug(
            "P2P? isModerator: " + isModerator
            + ", peerCount: " + peerCount + " => " + shouldBeInP2P);

        // Clear deferred "start P2P" task
        if (!shouldBeInP2P && this.deferredStartP2P) {
            logger.info("Cleared deferred start P2P task");
            window.clearTimeout(this.deferredStartP2P);
            this.deferredStartP2P = null;
        }
        // Start peer to peer session
        if (isModerator && !this.peerToPeerSession && shouldBeInP2P) {
            const peer = peerCount && peers[0];

            // Everyone is a moderator ?
            if (isModerator && peer.getRole() === 'moderator') {
                const myId = this.myUserId();
                const peersId = peer.getId();
                if (myId > peersId) {
                    logger.debug(
                        "Everyone's a moderator - "
                            + "the other peer should start P2P", myId, peersId);
                    // Abort
                    return;
                } else if (myId == peersId) {
                    logger.error("The same IDs ? ", myId, peersId);
                }
            }
            const jid = peer.getJid();
            if (userLeftEvent) {
                if (this.deferredStartP2P) {
                    logger.error("Deferred start P2P task's been set already!");
                    // Abort
                    return;
                }
                logger.info(
                    "Will start P2P with: " + jid
                        + " after " + this.backToP2PDelay + " seconds...");
                this.deferredStartP2P = window.setTimeout(
                    this._startPeer2PeerSession.bind(this, jid),
                    this.backToP2PDelay * 1000);
            } else {
                logger.info("Will start P2P with: " + jid);
                this._startPeer2PeerSession(jid);
            }
        } else if (isModerator && this.peerToPeerSession && !shouldBeInP2P){
            logger.info(
                "Will stop P2P with: " + this.peerToPeerSession.peerjid);
            this._stopPeer2PeerSession();
        }
    }

    /**
     * Stops the current P2P session.
     * @private
     */
    _stopPeer2PeerSession() {
        if (!this.peerToPeerSession) {
            logger.error("No P2P session to be stopped!");
            return;
        }

        // Add local track to JVB
        this._addLocalTracksToJVB();

        // Swap remote tracks, but only if the P2P has been fully established
        if (this.p2pEstablished) {
            // Remove remote P2P tracks
            this._removeP2PRemoteTracks();
            // Add back remote JVB tracks
            this._addRemoteJVBTracks();
        }

        // Stop P2P stats
        logger.info("Stopping remote stats with P2P connection");
        this.statistics.stopRemoteStats();

        if (JingleSessionState.ENDED !== this.peerToPeerSession.state) {
            this.peerToPeerSession.terminate(
                'success', 'Turing off P2P session',
                () => { logger.info("P2P session terminate RESULT"); },
                (error) => {
                    logger.warn(
                        "An error occurred while trying to terminate"
                        + " P2P Jingle session", error);
                });
        }

        this.peerToPeerSession = null;
        // Clear fake room state
        this.peerToPeerFakeRoom = null;
        // Update P2P status and other affected events/states
        this._setNewP2PStatus(false);

        // Start remote stats
        logger.info("Starting remote stats with JVB connection");
        if (this.jingleSession) {
            this._ensureRemoteStatsRunning();
        }
    }

    /**
     * Tells whether or not the media connection has been interrupted based on
     * the current P2P vs JVB status.
     * @inheritDoc
     * @override
     */
    isConnectionInterrupted () {
        return this.p2pEstablished
            ? this.isP2PConnectionInterrupted : super.isConnectionInterrupted();
    }

    /**
     * @inheritDoc
     * @override
     */
    isP2PEstablished() {
        return this.p2pEstablished;
    }

    /**
     * @inheritDoc
     * @override
     */
    getConnectionState () {
        const p2pState = this.getP2PConnectionState();
        if (p2pState) {
            return p2pState;
        } else {
            return super.getConnectionState();
        }
    }

    /**
     * Returns the current ICE state of the P2P connection.
     * @return {string|null} an ICE state or <tt>null</tt> if there's currently
     * no P2P connection.
     */
    getP2PConnectionState() {
        if (this.p2pEstablished && this.peerToPeerSession) {
            return this.peerToPeerSession.getIceConnectionState();
        } else {
            return null;
        }
    }

    /**
     * @inheritDoc
     * @override
     */
    onCallAccepted (jingleSession, answer) {
        if (this.peerToPeerSession === jingleSession) {
            logger.info("Doing setAnswer");
            this.peerToPeerSession.setAnswer(answer);
        }
    }

    /**
     * @inheritDoc
     * @override
     */
    onCallEnded (JingleSession, reasonCondition, reasonText) {
        logger.info(
            "Call ended: " + reasonCondition + " - "
            + reasonText + " P2P ?" + JingleSession.isP2P);
        if (JingleSession === this.peerToPeerSession) {
            // FIXME not sure if that's ok to not call the super
            // check CallStats and other things
            this._stopPeer2PeerSession();
        } else {
            super.onCallEnded(JingleSession, reasonCondition, reasonText);
        }
    }

    /**
     * Answers the incoming P2P Jingle call.
     * @inheritDoc
     * @override
     */
    onIncomingCall (jingleSession, jingleOffer, now) {
        if (typeof  jingleSession.isP2P === 'undefined') {
            // FIXME isFocus seems to be unreliable ? See fix note in ChatRoom
            jingleSession.isP2P = !this.room.isFocus(jingleSession.peerjid);
            // It is important to print that, as long as isFocus is unreliable.
            logger.info(
                "Marking session from " + jingleSession.peerjid
                + (jingleSession.isP2P ? " as P2P" : " as *not* P2P"));
        }
        if (jingleSession.isP2P) {
            const role = this.room.getMemberRole(jingleSession.peerjid);
            if ('moderator' !== role) {
                // Reject incoming P2P call
                this._rejectIncomingCallNonModerator(jingleSession);
            } else if (this.peerToPeerSession) {
                // Reject incoming P2P call (already in progress)
                this._rejectIncomingCall(
                    jingleSession,
                    "busy", "P2P already in progress",
                    "Duplicated P2P 'session-initiate'");
            } else {
                // Accept incoming P2P call
                this._acceptP2PIncomingCall(jingleSession, jingleOffer);
            }
        } else {
            // Let the JitsiConference deal with the JVB session
            super.onIncomingCall(jingleSession, jingleOffer, now);
        }
    }

    /**
     * Local role change may trigger new P2P session if 'everyone's a moderator'
     * plugin is enabled.
     * @inheritDoc
     * @override
     */
    onLocalRoleChanged (newRole) {
        super.onLocalRoleChanged(newRole);
        // Maybe start P2P
        this._startStopP2PSession();
    }

    /**
     * @inheritDoc
     * @override
     */
    onMemberJoined (jid, nick, role, isHidden) {
        super.onMemberJoined(jid, nick, role, isHidden);

        this._startStopP2PSession();
    }

    /**
     * @inheritDoc
     * @override
     */
    onMemberLeft (jid) {
        super.onMemberLeft(jid);

        this._startStopP2PSession(true /* triggered by user left event */);
    }

    /**
     * Called when {@link XMPPEvents.CONNECTION_INTERRUPTED} occurs on the P2P
     * connection.
     */
    onP2PIceConnectionInterrupted () {
        this.isP2PConnectionInterrupted = true;
        if (this.p2pEstablished)
            this._originalEmit(JitsiConferenceEvents.CONNECTION_INTERRUPTED);
    }

    /**
     * Called when {@link XMPPEvents.CONNECTION_RESTORED} occurs on the P2P
     * connection.
     */
    onP2PIceConnectionRestored () {
        this.isP2PConnectionInterrupted = false;
        if (this.p2pEstablished)
            this._originalEmit(JitsiConferenceEvents.CONNECTION_RESTORED);
    }

    /**
     * @inheritDoc
     * @override
     */
    onRemoteTrackAdded (track) {
        if (track.isP2P && !this.p2pEstablished) {
            logger.info(
                "Trying to add remote P2P track, when not in P2P - IGNORED");
        } else if (!track.isP2P && this.p2pEstablished) {
            logger.info(
                "Trying to add remote JVB track, when in P2P - IGNORED");
        } else {
            super.onRemoteTrackAdded(track);
        }
    }

    /**
     * {@inheritDoc}
     * @override
     */
    onTransportInfo (jingleSession, transportInfo) {
        if (this.peerToPeerSession === jingleSession) {
            logger.info("Doing set transport-info");
            this.peerToPeerSession.addIceCandidates(transportInfo);
        }
    }

    /**
     * Manually starts new P2P session (should be used only in the tests).
     */
    startPeer2PeerSession() {
        const peers = this.getParticipants();
        // Start peer to peer session
        if (peers.length > 0) {
            const peerJid = peers[0].getJid();
            this._startPeer2PeerSession(peerJid);
        } else {
            logger.error("No participant to start the P2P session with !");
        }
    }

    /**
     * Manually stops the current P2P session (should be used only in the tests)
     */
    stopPeer2PeerSession() {
        this._stopPeer2PeerSession();
    }
}

/**
 * This is a fake {@link ChatRoom} passed to the P2P {@link JingleSessionPC}
 * in order to capture events emitted on it's event emitter (Jingle session uses
 * chat room's emitter to send events).
 */
class FakeChatRoomLayer {

    /**
     * Creates new <tt>FakeChatRoomLayer</tt>
     * @param p2pConference parent <tt>P2PEnabledConference</tt> instance
     */
    constructor(p2pConference) {

        /**
         * @type P2PEnabledConference
         */
        this.p2pConf = p2pConference;

        /**
         * See whatever docs are provided in
         * the {@link ChatRoom#connectionTimes}.
         * @type {Array}
         */
        this.connectionTimes = [];

        /**
         * Maps options of the original <tt>ChatRoom</tt>
         */
        this.options = p2pConference.room.options;
        if (!this.options) {
            logger.error("ChatRoom.options are undefined");
        }

        /**
         * Partial implementation of the <tt>EventEmitter</tt> used to intercept
         * events emitted by the P2P {@link JingleSessionPC}
         * @type {EventEmitter}
         */
        this.eventEmitter = this._createEventEmitter();
    }

    /**
     * Creates fake event emitter used to intercept some of the XMPP events
     * coming from the P2P JingleSession.
     * @return {EventEmitter}
     * @private
     */
    _createEventEmitter () {
        const self = this;
        return {
            emit: function (type) {
                logger.debug("Fake emit: ", type, arguments);
                switch (type) {
                    case XMPPEvents.CONNECTION_ESTABLISHED:
                        self.p2pConf._onP2PConnectionEstablished(arguments[1]);
                        break;
                    case XMPPEvents.CONNECTION_INTERRUPTED:
                        self.p2pConf.onP2PIceConnectionInterrupted();
                        break;
                    case XMPPEvents.CONNECTION_RESTORED:
                        self.p2pConf.onP2PIceConnectionRestored();
                        break;
                    case XMPPEvents.CONNECTION_ICE_FAILED:
                        self.p2pConf._stopPeer2PeerSession();
                        break;
                }
            }
        };
    }

    /**
     * Executes given <tt>callback</tt> with <tt>ChatRoom</tt> with the original
     * <tt>ChatRoom</tt> instance obtained from <tt>JitsiConference</tt>. In
     * case it's not available anymore the callback will NOT be executed.
     * @param {function(ChatRoom)} callback the function to be executed
     * @private
     */
    _forwardToChatRoom (callback) {
        const room = this.p2pConf.room;
        if (room) {
            callback(room);
        } else {
            logger.error("XMPP chat room is null");
        }
    }

    /**
     * @see SignallingLayer.addPresenceListener
     */
    addPresenceListener (name, handler) {
        // Forward to origin ChatRoom
        this._forwardToChatRoom((room => {
            room.addPresenceListener(name, handler);
        }));
    }

    /**
     * @see SignallingLayer.getMediaPresenceInfo
     */
    getMediaPresenceInfo (endpointId, mediaType) {
        let result = null;
        this._forwardToChatRoom((room) =>{
            result = room.getMediaPresenceInfo(endpointId, mediaType);
        });
        return result;
    }

    /**
     * @see SignallingLayer.removePresenceListener
     */
    removePresenceListener (name) {
        this._forwardToChatRoom((room) => {
            room.removePresenceListener(name);
        });
    }
}
