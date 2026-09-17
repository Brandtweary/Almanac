"""Controlled ranking arms over a frozen independently retrieved candidate pool."""
from __future__ import annotations
import math


def cross_encoder_order(pool: list[dict], scores: list[tuple[str, float]]) -> list[str]:
    """Reject partial/misaligned batches before assigning query-passage scores."""
    expected={hit['passage_id'] for hit in pool}
    ids=[key for key,_ in scores]
    if len(expected)!=len(pool) or len(ids)!=len(expected) or set(ids)!=expected:
        raise ValueError('Cross-encoder must score each distinct pool handle exactly once')
    if any(type(score) not in (int,float) or not math.isfinite(score) for _,score in scores):
        raise ValueError('Cross-encoder scores must be finite numbers')
    return [key for key,_ in sorted(scores,key=lambda item:(-item[1],item[0]))]


def mmr_order(relevance_order: list[str], vectors: dict[str,list[float]], *, relevance_weight: float) -> list[str]:
    """Rank-percentile relevance and cosine mapped [-1,1] -> [0,1].

    This defined scale transform is a comparison arm, not empirical calibration
    or a production default. Weight must be chosen on development evidence, then
    frozen before heldout scoring. It cannot assert novelty is task relevance.
    """
    if type(relevance_weight) not in (int,float) or not math.isfinite(relevance_weight) or not 0<=relevance_weight<=1:
        raise ValueError('Explicit finite MMR relevance weight in [0,1] required')
    if not relevance_order or len(set(relevance_order))!=len(relevance_order) or set(vectors)!=set(relevance_order):
        raise ValueError('Vectors and unique candidate handles must align')
    dimensions={len(vector) for vector in vectors.values()}
    if len(dimensions)!=1 or 0 in dimensions:
        raise ValueError('Embedding dimensions differ or are empty')
    unit={}
    for key,vector in vectors.items():
        if any(type(v) not in (int,float) or not math.isfinite(v) for v in vector):
            raise ValueError('Embeddings must be finite')
        norm=math.sqrt(sum(v*v for v in vector))
        if not math.isfinite(norm) or norm==0: raise ValueError('Invalid embedding norm')
        unit[key]=[v/norm for v in vector]
    relevance={key:1-rank/max(1,len(relevance_order)-1) for rank,key in enumerate(relevance_order)}
    remaining=set(relevance_order); selected=[]
    redundancy={key:0.0 for key in relevance_order}
    while remaining:
        def score(key):
            return relevance_weight*relevance[key]-(1-relevance_weight)*redundancy[key]
        best=min(remaining,key=lambda key:(-score(key),-relevance[key],key))
        selected.append(best); remaining.remove(best)
        for key in remaining:
            similarity=(1+max(-1,min(1,sum(a*b for a,b in zip(unit[key],unit[best])))))/2
            redundancy[key]=max(redundancy[key],similarity)
    return selected
