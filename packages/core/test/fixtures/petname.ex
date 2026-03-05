defmodule Arc.Identity.Petname do
  @moduledoc """
  Deterministic human-readable names from public keys.

  Derives an adjective-noun-suffix petname from Blake3(public_key).
  Same key always produces the same name.

      iex> Arc.Identity.Petname.from_public_key(some_pk)
      "bold-einstein-3a7f0bc1"

      iex> Arc.Identity.Petname.short(some_pk)
      "bold-einstein"
  """

  @adjectives_list ~w(
    able acid adept agile airy alert alive alpine
    amber ample aqua arch arctic ardent ashen astral
    atomic avid azure bare basic blaze bliss bold
    brave brief bright brisk broad bronze calm candid
    cedar chief chill civic clear clever cobalt cool
    copper coral cosmic cozy crisp cross crystal cubic
    cyan dapper daring dawn deep deft dense divine
    dream dry dual dusk dusty eager early earnest
    elder ember epic equal even extra faint fair
    fast fern fierce final fine firm first fleet
    flint flora fluid focal forged free fresh frost
    full gentle gilt glad gleam global glow golden
    grand grassy green grey hale happy hardy hazel
    hearty heavy hidden high hollow honest honed humble
    icy ideal inner iron ivory jade jolly jovial
    just keen kind lapis lean level light lilac
    linen live lofty long loyal lucid lucky lunar
    major maple marble mellow merry micro mighty mild
    mint misty modal modest mossy muted natal near
    neat new next nimble noble north novel oaken
    ocean olive onyx opal open orbit outer palm
    pastel patient peak pearl pilot pine plain plucky
    plush polar prime proof proud pulse pure quartz
    quick quiet radiant rapid rare raven raw ready
    regal rich ripe rising rocky rolling rose round
    royal ruby rustic sacred sage sandy satin scarlet
    serene sharp sheer shining silent silk silver simple
    sleek slim smooth snowy solar solid sonic south
    spark spice spring stark steady steep stellar still
    stone stout strong subtle sunlit swift teal tender
    tidal timber topaz true ultra vast vivid warm
    waving west whole wild winter wise witty zen
  )

  @nouns_list ~w(
    abel adams agnesi aiken airy ampere anning appleton
    arago archimedes aristotle atiyah avogadro ayrton babbage bacon
    banach barrow becquerel bell benz bernoulli bessel bohm
    bohr boltzmann boole bose boyle bragg brahe bronte
    brown bunsen cantor carnot cartan carson cassini cauchy
    cayley celsius chadwick chandler chebyshev clarke clausius conway
    copernicus cori coulomb crick curie dalton darwin davy
    debye dedekind democritus descartes diesel diophantus dirac doppler
    drake dyson earnshaw eddington edison ehrenfest einstein ekman
    erdos euclid eudoxus euler faraday fermat fermi feynman
    fibonacci fleming fourier franklin fresnel gagarin galileo galois
    galvani gamow gauss germain gibbs glenn godel goldbach
    goodall gray green gutenberg haber halley hamilton hardy
    harriot hawking heaviside heisenberg helmholtz herschel hertz hilbert
    hodgkin hooke hopper hubble humboldt huygens hypatia jacobi
    jeans jenner johnson jordan joule jung kapitza kelvin
    kepler kerr kirchhoff klein knuth kolmogorov kronecker kruskal
    kuiper lagrange lamarck landau laplace larmor lavoisier leavitt
    leibniz lemaitre lie linde linnaeus lister lorenz lorentz
    lovelace lyell mach mandela marconi maxwell mcclintock mendel
    mendeleev mercator milnor minkowski mobius morse nagata napier
    nash neumann newcomb newton nobel noether ohm oppenheimer
    orwell pascal pasteur pauli pauling penrose picard planck
    poincare ptolemy pythagoras raman ramanujan riemann rutherford sagan
    sakurai salk schrodinger shannon shelley simone snell socrates
    sommerfeld stokes sullivan szilard tate tesla thales thompson
    thoreau turing tyndall venn verne volta wallace watson
    watt weber wegener weil weyl wheeler whitman wigner
    wiles witten wozniak wright yang yukawa zeno zermelo
    zheng zorn zuse zwicky blackwell bolzano cardano cavendish
    clifford compton dirichlet ferrel galton gentzen glashow hahn
    huggins huxley langley meitner navier poisson rayleigh wien
  )

  # Compile-time validation
  @adj_count length(@adjectives_list)
  @noun_count length(@nouns_list)

  unless @adj_count == 256, do: raise("Expected 256 adjectives, got #{@adj_count}")
  unless @noun_count == 256, do: raise("Expected 256 nouns, got #{@noun_count}")

  @adjectives List.to_tuple(@adjectives_list)
  @nouns List.to_tuple(@nouns_list)

  @doc """
  Full petname from a public key: "bold-einstein-3a7f0bc1"
  """
  @spec from_public_key(<<_::256>>) :: String.t()
  def from_public_key(<<public_key::binary-size(32)>>) do
    <<adj_idx, noun_idx, s1, s2, s3, s4, _::binary>> = B3.hash(public_key)
    adj = elem(@adjectives, adj_idx)
    noun = elem(@nouns, noun_idx)
    suffix = Base.encode16(<<s1, s2, s3, s4>>, case: :lower)
    "#{adj}-#{noun}-#{suffix}"
  end

  @doc """
  Short petname from a public key: "bold-einstein"
  """
  @spec short(<<_::256>>) :: String.t()
  def short(<<public_key::binary-size(32)>>) do
    <<adj_idx, noun_idx, _::binary>> = B3.hash(public_key)
    adj = elem(@adjectives, adj_idx)
    noun = elem(@nouns, noun_idx)
    "#{adj}-#{noun}"
  end
end
