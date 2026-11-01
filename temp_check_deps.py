try:
    import torch
    import numpy
    print("torch", torch.__version__)
    print("numpy", numpy.__version__)
except Exception as error:
    print("IMPORT_ERROR:", type(error).__name__, error)
