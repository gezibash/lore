defmodule Arc.Identity do
  @moduledoc """
  The identity axiom: every participant on ARC is a keypair first.

  A seed (32 bytes of entropy) deterministically derives an Ed25519 keypair.
  The seed is the identity — same seed, same keypair, any device.

  Each identity has a deterministic petname derived from its public key,
  e.g. "bold-einstein-3a7f0bc1". Short form: "bold-einstein".
  """

  @seed_bytes 32

  @type seed :: <<_::256>>
  @type public_key :: <<_::256>>
  @type secret_key :: <<_::256>>

  @type t :: %__MODULE__{
          seed: seed(),
          public_key: public_key(),
          secret_key: secret_key()
        }

  @enforce_keys [:seed, :public_key, :secret_key]
  defstruct [:seed, :public_key, :secret_key]

  @doc """
  Generate a new random identity.
  """
  @spec generate() :: t()
  def generate do
    seed = :crypto.strong_rand_bytes(@seed_bytes)
    from_seed(seed)
  end

  @doc """
  Derive an identity from an existing seed.
  Deterministic: same seed always produces the same identity.
  """
  @spec from_seed(seed()) :: t()
  def from_seed(<<seed::binary-size(@seed_bytes)>>) do
    {public_key, secret_key} = :crypto.generate_key(:eddsa, :ed25519, seed)

    %__MODULE__{
      seed: seed,
      public_key: public_key,
      secret_key: secret_key
    }
  end

  @doc """
  Sign a message with this identity's secret key.
  """
  @spec sign(t(), binary()) :: binary()
  def sign(%__MODULE__{secret_key: sk}, message) when is_binary(message) do
    :crypto.sign(:eddsa, :none, message, [sk, :ed25519])
  end

  @doc """
  Verify a signature against a public key.
  """
  @spec verify(public_key(), binary(), binary()) :: boolean()
  def verify(<<public_key::binary-size(32)>>, message, signature)
      when is_binary(message) and is_binary(signature) do
    :crypto.verify(:eddsa, :none, message, signature, [public_key, :ed25519])
  end

  @doc """
  Derive an X25519 keypair from this identity for ECDH key exchange.
  Returns {x25519_public, x25519_secret}.
  """
  @spec to_x25519(t()) :: {binary(), binary()}
  def to_x25519(%__MODULE__{secret_key: sk}) do
    # Ed25519 secret key can be used as X25519 seed via clamping
    # OTP handles the conversion internally when we use the same seed
    :crypto.generate_key(:ecdh, :x25519, sk)
  end

  @doc """
  Encode a public key as a hex string.
  """
  @spec encode_public_key(t() | public_key()) :: String.t()
  def encode_public_key(%__MODULE__{public_key: pk}), do: Base.encode16(pk, case: :lower)
  def encode_public_key(<<pk::binary-size(32)>>), do: Base.encode16(pk, case: :lower)

  @doc """
  Full petname: "bold-einstein-3a7f0bc1"
  """
  @spec name(t() | public_key()) :: String.t()
  def name(%__MODULE__{public_key: pk}), do: Arc.Identity.Petname.from_public_key(pk)
  def name(<<pk::binary-size(32)>>), do: Arc.Identity.Petname.from_public_key(pk)

  @doc """
  Short petname: "bold-einstein"
  """
  @spec short_name(t() | public_key()) :: String.t()
  def short_name(%__MODULE__{public_key: pk}), do: Arc.Identity.Petname.short(pk)
  def short_name(<<pk::binary-size(32)>>), do: Arc.Identity.Petname.short(pk)
end
