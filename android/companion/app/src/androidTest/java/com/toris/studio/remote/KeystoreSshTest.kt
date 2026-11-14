package com.toris.studio.remote

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.jcraft.jsch.JSch
import org.apache.sshd.common.config.keys.KeyUtils
import org.apache.sshd.common.config.keys.PublicKeyEntry
import org.apache.sshd.common.util.io.PathUtils
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.auth.pubkey.PublickeyAuthenticator
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger

/** Real SSH public-key authentication against an isolated loopback test server. */
@RunWith(AndroidJUnit4::class)
class KeystoreSshTest {
    @Test fun keystoreSignsARealSshAuthenticationWithoutExportingTheKey() {
        val alias = "toris-studio-remote-instrumentation"
        val identity = KeystoreIdentity(alias)
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val publicKey = store.getCertificate(alias).publicKey
        assertNull(store.getKey(alias, null).encoded)

        val hostKey = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
            .resolve("ssh-test-host-key.ser")
        PathUtils.setUserHomeFolderResolver { hostKey.parentFile!!.toPath() }
        val authentications = AtomicInteger()
        val server = SshServer.setUpDefaultServer().apply {
            host = "127.0.0.1"
            port = 0
            keyPairProvider = SimpleGeneratorHostKeyProvider(hostKey.toPath()).apply {
                algorithm = "EC"
                keySpec = java.security.spec.ECGenParameterSpec("secp256r1")
            }
            publickeyAuthenticator = PublickeyAuthenticator { _, key, _ ->
                authentications.incrementAndGet()
                KeyUtils.compareKeys(publicKey, key)
            }
        }
        try {
            server.start()
            val hostPublicKey = server.keyPairProvider.loadKeys(null).first().public
            val hostBlob = Base64.getDecoder().decode(PublicKeyEntry.toString(hostPublicKey).split(" ")[1])
            val wrongClient = JSch().apply {
                addIdentity(identity, null)
                hostKeyRepository = HostKeyPin(HostKeyPin.fingerprint(byteArrayOf(1, 2, 3)))
            }
            val wrongSession = wrongClient.getSession("test", "127.0.0.1", server.port).apply {
                setConfig("StrictHostKeyChecking", "yes")
                setConfig("PreferredAuthentications", "publickey")
            }
            try {
                org.junit.Assert.assertThrows(com.jcraft.jsch.JSchException::class.java) { wrongSession.connect(10_000) }
                org.junit.Assert.assertEquals(0, authentications.get())
            } finally {
                wrongSession.disconnect()
            }
            val client = JSch().apply {
                addIdentity(identity, null)
                hostKeyRepository = HostKeyPin(HostKeyPin.fingerprint(hostBlob))
            }
            val session = client.getSession("test", "127.0.0.1", server.port).apply {
                setConfig("StrictHostKeyChecking", "yes")
                setConfig("PreferredAuthentications", "publickey")
                setConfig("userauth.none", DeviceAuthNone::class.java.name)
            }
            try {
                session.connect(10_000)
                assertTrue(session.isConnected)
            } finally {
                session.disconnect()
            }
        } finally {
            server.stop(true)
            hostKey.delete()
            store.deleteEntry(alias)
        }
    }
}
