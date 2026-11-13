package com.toris.studio.remote

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.jcraft.jsch.Identity
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/** JSch receives signatures, never the Android Keystore private key bytes. */
internal class KeystoreIdentity(private val alias: String = "toris-studio-remote-v1") : Identity {
    private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    init {
        synchronized(lock) {
            if (!store.containsAlias(alias)) {
                KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                    initialize(
                        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                            .setDigests(KeyProperties.DIGEST_SHA256)
                            .setUserAuthenticationRequired(false)
                            .build()
                    )
                    generateKeyPair()
                }
            }
        }
    }

    override fun getPublicKeyBlob(): ByteArray = SshEncoding.publicKey(store.getCertificate(alias).publicKey as ECPublicKey)
    override fun getSignature(data: ByteArray): ByteArray? = getSignature(data, SshEncoding.ALGORITHM)
    override fun getSignature(data: ByteArray, alg: String): ByteArray? {
        if (alg != SshEncoding.ALGORITHM) return null
        return try {
            val key = store.getKey(alias, null) as java.security.PrivateKey
            val der = Signature.getInstance("SHA256withECDSA").run { initSign(key); update(data); sign() }
            SshEncoding.signature(der)
        } catch (_: java.security.GeneralSecurityException) {
            null
        }
    }
    override fun setPassphrase(passphrase: ByteArray?): Boolean = true
    override fun getAlgName(): String = SshEncoding.ALGORITHM
    override fun getName(): String = alias
    override fun isEncrypted(): Boolean = false
    override fun clear() = Unit

    private companion object { val lock = Any() }
}
