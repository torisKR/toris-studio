package com.toris.studio.remote

import org.junit.Assert.*
import org.junit.Test
import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

class SshEncodingTest {
    private fun readString(buffer: ByteBuffer): ByteArray = ByteArray(buffer.int).also { buffer.get(it) }

    @Test fun encodesP256PointAndSignatureForSsh() {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val blob = ByteBuffer.wrap(SshEncoding.publicKey(pair.public as ECPublicKey))
        assertEquals(SshEncoding.ALGORITHM, String(readString(blob)))
        assertEquals("nistp256", String(readString(blob)))
        val point = readString(blob)
        assertEquals(65, point.size)
        assertEquals(4, point[0].toInt())
        val public = pair.public as ECPublicKey
        assertEquals(public.w.affineX, BigInteger(1, point.copyOfRange(1, 33)))
        assertEquals(public.w.affineY, BigInteger(1, point.copyOfRange(33, 65)))
        assertFalse(blob.hasRemaining())

        val message = "SSH authentication".toByteArray()
        val der = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(message); sign() }
        val encoded = ByteBuffer.wrap(SshEncoding.signature(der))
        assertEquals(SshEncoding.ALGORITHM, String(readString(encoded)))
        val values = ByteBuffer.wrap(readString(encoded))
        assertTrue(BigInteger(readString(values)).signum() > 0)
        assertTrue(BigInteger(readString(values)).signum() > 0)
        assertFalse(values.hasRemaining())
        assertFalse(encoded.hasRemaining())
    }

    @Test fun rejectsMalformedDerSignatures() {
        listOf(byteArrayOf(), byteArrayOf(0x30, 0), byteArrayOf(0x30, 0x03, 0x02, 0x01, 0x80.toByte())).forEach {
            assertThrows(IllegalArgumentException::class.java) { SshEncoding.signature(it) }
        }
    }
}
