package com.toris.studio.remote

import com.jcraft.jsch.ChannelSubsystem
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.Identity
import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.Session
import com.jcraft.jsch.SocketFactory
import com.jcraft.jsch.UserAuthNone
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** JSch normally accepts SSH 'none' for any user. Device sessions must prove key possession. */
class DeviceAuthNone : UserAuthNone() {
    override fun start(session: Session): Boolean {
        if (super.start(session)) throw JSchException("device requires public-key authentication")
        return false
    }
}

private class SigningIdentity(private val delegate: Identity) : Identity by delegate {
    var signed = false
        private set
    override fun getSignature(data: ByteArray): ByteArray? = delegate.getSignature(data)?.also { signed = true }
    override fun getSignature(data: ByteArray, alg: String): ByteArray? = delegate.getSignature(data, alg)?.also { signed = true }
}

private class TrackingPin(fingerprint: String) : HostKeyRepository by HostKeyPin(fingerprint) {
    private val pin = HostKeyPin(fingerprint)
    var mismatch = false
        private set
    override fun check(host: String?, key: ByteArray): Int = pin.check(host, key).also {
        if (it != HostKeyRepository.OK) mismatch = true
    }
}

/** Connections and sockets are closed when the activity leaves the foreground. */
internal class SshConnector(private val identity: Identity) : RemoteConnector {
    private val lock = Any()
    private var foreground = false
    private var generation = 0L
    private val sockets = mutableSetOf<Socket>()
    private val sessions = mutableSetOf<Session>()
    private val connections = mutableSetOf<SshConnection>()
    override fun start() { synchronized(lock) { foreground = true } }
    override fun stop() {
        val toClose = synchronized(lock) {
            foreground = false
            generation++
            val value = Triple(sockets.toList(), sessions.toList(), connections.toList())
            sockets.clear(); sessions.clear(); connections.clear()
            value
        }
        // Closing sockets immediately stops network access; channel shutdown can
        // block in the SSH library, so never wait for it on the activity thread.
        toClose.first.forEach { runCatching { it.close() } }
        Thread({
            toClose.third.forEach { it.close() }
            toClose.second.forEach { runCatching { it.disconnect() } }
        }, "remote-close").apply { isDaemon = true; start() }
    }
    private fun register(socket: Socket, expected: Long) = synchronized(lock) {
        if (!foreground || generation != expected) { socket.close(); throw RemoteError("앱이 화면에 있을 때 다시 연결하세요.") }
        sockets.add(socket)
    }
    private fun register(session: Session, expected: Long) = synchronized(lock) {
        if (!foreground || generation != expected) throw RemoteError("앱이 화면에 있을 때 다시 연결하세요.")
        sessions.add(session)
    }
    private fun register(connection: SshConnection, expected: Long) = synchronized(lock) {
        if (!foreground || generation != expected) throw RemoteError("앱이 화면에 있을 때 다시 연결하세요.")
        connections.add(connection)
    }
    private fun remove(session: Session, socket: Socket?) = synchronized(lock) {
        sessions.remove(session)
        if (socket != null) sockets.remove(socket)
    }

    override fun open(mac: MacAddress, authentication: Authentication): RemoteConnection {
        require(PairingData.isPrivateIpv4(mac.host) && mac.port in 1..65535)
        val epoch = synchronized(lock) {
            if (!foreground) throw RemoteError("앱이 화면에 있을 때 다시 연결하세요.")
            generation
        }
        val pin = TrackingPin(mac.fingerprint)
        val signing = SigningIdentity(identity)
        val jsch = JSch().apply {
            hostKeyRepository = pin
            if (authentication == Authentication.DEVICE) addIdentity(signing, null)
        }
        var rawSocket: Socket? = null
        val session = jsch.getSession(if (authentication == Authentication.DEVICE) "device" else "enroll", mac.host, mac.port).apply {
            setConfig("StrictHostKeyChecking", "yes")
            setConfig("PreferredAuthentications", if (authentication == Authentication.DEVICE) "publickey" else "")
            if (authentication == Authentication.DEVICE) setConfig("userauth.none", DeviceAuthNone::class.java.name)
            setSocketFactory(object : SocketFactory {
                override fun createSocket(host: String, port: Int): Socket {
                    val socket = Socket()
                    rawSocket = socket
                    register(socket, epoch)
                    socket.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
                    socket.soTimeout = REQUEST_TIMEOUT_MS
                    return socket
                }
                override fun getInputStream(socket: Socket): InputStream = socket.getInputStream()
                override fun getOutputStream(socket: Socket): OutputStream = socket.getOutputStream()
            })
        }
        register(session, epoch)
        try {
            session.connect(CONNECT_TIMEOUT_MS)
            if (authentication == Authentication.DEVICE && !signing.signed) throw RemoteError("기기 공개키 서명을 확인하지 못했습니다.")
            val channel = session.openChannel("subsystem") as ChannelSubsystem
            channel.setSubsystem("toris-mobile-v1")
            channel.setWantReply(true)
            val input = channel.inputStream.buffered()
            val output = channel.outputStream.buffered()
            channel.connect(CONNECT_TIMEOUT_MS)
            lateinit var connection: SshConnection
            connection = SshConnection(session, channel, input, output) {
                runCatching { rawSocket?.close() }
                remove(session, rawSocket)
                synchronized(lock) { connections.remove(connection) }
            }
            try { register(connection, epoch) } catch (error: Exception) { connection.close(); throw error }
            return connection
        } catch (error: Exception) {
            runCatching { session.disconnect() }
            runCatching { rawSocket?.close() }
            remove(session, rawSocket)
            if (error is RemoteError) throw error
            if (pin.mismatch) throw RemoteError("Mac의 호스트 키가 변경되었습니다. 연결을 중단했습니다. Mac에서 다시 등록하세요.")
            if (error is JSchException && error.message?.contains("auth fail", ignoreCase = true) == true) {
                throw RemoteError(if (authentication == Authentication.DEVICE)
                    "기기 인증이 거부되었습니다. 등록 해제되었거나 키가 변경되었을 수 있습니다. Mac의 기기 목록을 확인하세요."
                else "등록 연결이 거부되었습니다. Mac에서 새 QR을 발급하세요.")
            }
            throw RemoteError("Mac에 연결할 수 없습니다. 같은 네트워크와 Mac 앱 실행 상태를 확인하세요.")
        }
    }
    private companion object {
        const val CONNECT_TIMEOUT_MS = 10_000
        const val REQUEST_TIMEOUT_MS = 25_000
    }
}

/** The watchdog closes the actual socket as well as the channel, even during blocked reads. */
private class SshConnection(
    private val session: Session, private val channel: ChannelSubsystem,
    private val input: InputStream, private val output: OutputStream, private val cleanup: () -> Unit,
) : RemoteConnection {
    private val closed = AtomicBoolean(false)
    private val timer = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "remote-deadline").apply { isDaemon = true }
    }
    @Synchronized override fun request(request: JSONObject): JSONObject {
        if (closed.get()) throw RemoteError("연결이 종료되었습니다. 다시 연결하세요.")
        val timedOut = AtomicBoolean(false)
        val timeout = timer.schedule({ timedOut.set(true); close() }, 25, TimeUnit.SECONDS)
        try {
            val bytes = request.toString().toByteArray(Charsets.UTF_8)
            if (bytes.size > 8192) throw RemoteError("요청이 너무 큽니다.")
            output.write(bytes); output.write('\n'.code); output.flush()
            return Protocol.envelope(readLine(input))
        } catch (error: Exception) {
            close()
            if (timedOut.get()) throw RemoteError("Mac 응답 시간이 초과되었습니다. 네트워크와 Mac 앱을 확인하세요.")
            if (error is RemoteError) throw error
            throw RemoteError("Mac 연결이 끊겼습니다. 다시 연결해 상태를 확인하세요.")
        } finally {
            timeout.cancel(false)
        }
    }
    override fun close() {
        if (closed.compareAndSet(false, true)) {
            cleanup()
            runCatching { channel.disconnect() }
            runCatching { session.disconnect() }
            timer.shutdownNow()
        }
    }
}

internal fun readLine(input: InputStream): String {
    val result = ByteArrayOutputStream()
    while (true) {
        val next = input.read()
        if (next < 0) throw RemoteError("Mac 연결이 끊겼습니다. 다시 연결해 상태를 확인하세요.")
        if (next == '\n'.code) break
        if (result.size() >= 65_536) throw RemoteError("Mac의 응답이 너무 큽니다.")
        result.write(next)
    }
    return try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(result.toByteArray())).toString()
    } catch (_: Exception) { throw RemoteError("Mac의 응답 형식을 확인하세요.") }
}
