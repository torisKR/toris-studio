package com.toris.studio.remote

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.interfaces.ECPublicKey

/** The SSH wire representation is independent of the keystore's DER signatures. */
internal object SshEncoding {
    const val ALGORITHM = "ecdsa-sha2-nistp256"

    fun publicKey(key: ECPublicKey): ByteArray {
        require(key.params.curve.field.fieldSize == 256)
        val point = ByteArrayOutputStream().apply {
            write(4)
            write(coordinate(key.w.affineX))
            write(coordinate(key.w.affineY))
        }.toByteArray()
        return strings(ALGORITHM.toByteArray(Charsets.US_ASCII), "nistp256".toByteArray(Charsets.US_ASCII), point)
    }

    fun signature(der: ByteArray): ByteArray {
        var cursor = 0
        fun take(): Int {
            require(cursor < der.size) { "잘못된 서명 형식" }
            return der[cursor++].toInt() and 0xff
        }
        require(take() == 0x30)
        val length = take()
        require(length < 0x80 && length == der.size - cursor)
        fun integer(): ByteArray {
            require(take() == 0x02)
            val size = take()
            require(size in 1..33 && cursor + size <= der.size)
            val bytes = der.copyOfRange(cursor, cursor + size)
            cursor += size
            require(bytes[0].toInt() and 0x80 == 0)
            val value = BigInteger(1, bytes)
            require(value.signum() > 0 && value.bitLength() <= 256)
            return value.toByteArray()
        }
        val r = integer()
        val s = integer()
        require(cursor == der.size)
        return strings(ALGORITHM.toByteArray(Charsets.US_ASCII), strings(r, s))
    }

    private fun coordinate(value: BigInteger): ByteArray {
        require(value.signum() >= 0 && value.bitLength() <= 256)
        val bytes = value.toByteArray()
        val start = if (bytes.size == 33 && bytes[0] == 0.toByte()) 1 else 0
        val length = bytes.size - start
        return ByteArray(32).also { bytes.copyInto(it, 32 - length, start, bytes.size) }
    }

    private fun strings(vararg values: ByteArray): ByteArray = ByteArrayOutputStream().apply {
        values.forEach { value ->
            write((value.size ushr 24) and 255)
            write((value.size ushr 16) and 255)
            write((value.size ushr 8) and 255)
            write(value.size and 255)
            write(value)
        }
    }.toByteArray()
}
